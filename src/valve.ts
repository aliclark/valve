import { nextTick } from 'process'
import { Readable } from 'stream'

interface ReadablePipePipeJointContract {
  // To be invoked by a PipeJoint once it has been constructed.
  // The ReadablePipe should then begin to signal to `joint` when it has readable data.
  start(joint: PipeJoint): void
}

interface ReadablePipeContract {
  // The quantity or readable bytes, or -1 if unknown, and potentially >0
  readable(): number
  // Whether or not the consumer of the data can assume the buffer is theirs from now on
  acquirable(): boolean
  // Return a buffer containing available data, up to `size` bytes
  // `size` may be omitted or set to -1 to indicate as many bytes as possible.
  // `read()` liable to return a 0 length buffer if it's not acquirable, or async work is required
  read(size?: number): Buffer
  // The consumer invokes this method with a destination buffer, offset, and the amount of data to write
  // The callback is invoked with the number of bytes actually written into the destination buffer.
  // Nb. the callback may be invoked by readOnto synchronously, during the invocation.
  readOnto(
    target: Buffer,
    offset: number,
    size: number,
    callback: (amount: number) => void
  ): void
  // The consumer invokes this method to indicate that it has finished with the data
  // If the buffer was not acquirable, the consumer no longer use it after this point.
  callback(): void
}

export interface ReadablePipe
  extends ReadablePipeContract,
    ReadablePipePipeJointContract {}

interface WritablePipePipeJointContract {
  // A constant indicating a value 1 greater than the block size which the writable pipe
  // would typically accept without first deciding to perform buffering.
  // When determining a buffer size, `writableHighWaterMark - 1` is usually a good choice.
  readonly writableHighWaterMark: number
}

interface WritablePipeContract {
  // This method is invoked to provide data.
  // `callback` will only be invoked once the data is fully processed and written.
  // Until that point, the caller should refrain from using the buffer in any way.
  // Passing `undefined` as the second argument signals that the target buffer is acquirable,
  // ie. the receiver may assume ownership of the buffer from now on.
  write(target: Buffer, callback: () => void): void
  write(target: Buffer, _: undefined, callback: () => void): void
  // This method is invoked to indicate no more data will be provided.
  end(): void
}

export interface WritablePipe
  extends WritablePipeContract,
    WritablePipePipeJointContract {}

interface PipeJointReadablePipeContract {
  // Invoked by the read-side when new data becomes available.
  // If it is unknown how much data is available, the `size` argument may be -1
  // `acquirable` indicates whether the consumer may assume sole ownership of the buffer.
  // If true, then calls to read() on ReadablePipe should return the buffer reference without copying,
  // and similarly read(n) may return a Node Buffer slice which is not copied.
  readable(size: number, acquirable: boolean): void
  // Invoked by the read-side once all of its data has been consumed and no more data will be available.
  // This should be propagated by the PipeJoint to the write-side, unless configured otherwise.
  end(): void
}

interface PipeJointContract {
  // Invoked by the program to begin the writing of any data and end() the write-side if applicable.
  resume(): void
}

export interface PipeJoint
  extends PipeJointContract,
    PipeJointReadablePipeContract {}

export interface Transformer {
  transform(
    source: Buffer,
    target: Buffer,
    targetStart: number,
    targetEnd: number,
    sourceStart: number,
    sourceEnd: number,
    callback: (consumed: number, written: number) => void
  ): void
}

const emptyBuffer = Buffer.allocUnsafe(0)

class PassThroughTransformer implements Transformer {
  transform(
    source: Buffer,
    target: Buffer,
    targetStart: number,
    targetEnd: number,
    sourceStart: number,
    sourceEnd: number,
    callback: (consumed: number, written: number) => void
  ): void {
    const amount = Math.min(targetEnd - targetStart, sourceEnd - sourceStart)
    source.copy(target, targetStart, sourceStart, sourceStart + amount)
    callback(amount, amount)
  }
}

export const passThroughTransformer = new PassThroughTransformer()

export class TransformerPipe implements ReadablePipe, WritablePipe {

  readonly writableHighWaterMark: number

  private joint: PipeJoint | void = undefined
  private writeFinished: Function = () => {}

  private remainderIsAcquirable = false
  private remainder = emptyBuffer
  private remainderOffset = 0

  private buffer = emptyBuffer
  private bufferOffset = 0

  private flushing = false

  constructor(private readonly transformer: Transformer, blockSize: number) {
    this.writableHighWaterMark = blockSize + 1
  }

  start(joint: PipeJoint): void {
    this.joint = joint

    if (this.bufferOffset !== this.buffer.byteLength) {
      joint.readable(-1, false)
    } else if (this.flushing) {
      joint.end()
    }
  }

  readable(): number {
    return this.bufferOffset !== this.buffer.byteLength ? -1 : 0
  }

  acquirable(): boolean {
    return false
  }

  readOnto(
    target: Buffer,
    offset: number,
    askSize: number,
    callback: (amount: number) => void
  ): void {
    const buffer = this.buffer
    const bufferOffset = this.bufferOffset
    const bufferLength = buffer.byteLength

    const inputSize = bufferLength - bufferOffset

    this.transformer.transform(
      buffer,
      target,
      offset,
      offset + askSize,
      bufferOffset,
      bufferLength,
      (consumed, written) => {
        if (consumed !== inputSize) {
          this.remainder = buffer
          this.remainderOffset = bufferOffset + consumed
        }
        this.reset()

        callback(written)
      }
    )
  }

  read() {
    return emptyBuffer
  }

  private reset() {
    this.buffer = emptyBuffer
    this.bufferOffset = 0

    if (this.flushing) {
      nextTick(() => this.joint!.end())
    }
  }

  callback() {
    if (
      !this.remainderIsAcquirable &&
      this.remainderOffset !== this.remainder.byteLength
    ) {
      this.remainder = Buffer.from(this.remainder, this.remainderOffset)
      this.remainderOffset = 0
    }

    this.writeFinished()
  }

  write(target: Buffer, callback: () => void, _?: undefined): void
  write(target: Buffer, _: undefined, callback: () => void): void
  write(target: Buffer, a: unknown, b: unknown): void {

    var isAcquirable = false

    if (this.remainderOffset !== this.remainder.byteLength) {
      this.buffer = Buffer.concat([
        this.remainder.slice(this.remainderOffset),
        target,
      ])
      this.remainder = emptyBuffer
      this.remainderOffset = 0
    } else {
      this.buffer = target
    }

    if (typeof a === 'function') {
      this.writeFinished = a
    } else if (typeof b === 'function') {
      var isAcquirable = true
      this.writeFinished = b
    }
    this.remainderIsAcquirable = isAcquirable

    this.joint?.readable(-1, false)
  }

  end(): void {
    if (this.buffer.byteLength !== 0 || this.joint === undefined) {
      this.flushing = true
    } else {
      this.joint!.end()
    }
  }
}

export class ReadableStreamPipe implements ReadablePipe {

  private joint: PipeJoint | void = undefined

  private buffer = emptyBuffer
  private bufferOffset = 0

  private hasReadable = false
  private flushing = false

  constructor(private readonly readSide: Readable, readable = false) {
    readSide.addListener('readable', () => this.streamReadable())
    readSide.addListener('end', () => this.streamEnd())

    if (readable) {
      this.hasReadable = true
      this.callback()
    }
  }

  start(joint: PipeJoint) {
    this.joint = joint

    const readable = this.readable()

    if (readable !== 0) {
      joint.readable(readable, true)
    } else if (this.flushing) {
      joint.end()
    }
  }

  readable() {
    return this.buffer.byteLength - this.bufferOffset
  }

  acquirable() {
    return true
  }

  readOnto(
    target: Buffer,
    offset: number,
    size: number,
    callback: (amount: number) => void
  ): void {
    const buffer = this.buffer
    const bufferOffset = this.bufferOffset
    const end = bufferOffset + size
    buffer.copy(target, offset, bufferOffset, end)

    if (end === buffer.byteLength) {
      this.reset()
    } else {
      this.bufferOffset = end
    }

    callback(size)
  }

  read(size = -1) {
    const buffer = this.buffer

    if (size < 0) {
      this.reset()
      return buffer
    } else {
      const bufferOffset = this.bufferOffset
      const end = bufferOffset + size
      const slice = buffer.slice(bufferOffset, end)

      if (end === buffer.byteLength) {
        this.reset()
      } else {
        this.bufferOffset = end
      }

      return slice
    }
  }

  private reset() {
    this.buffer = emptyBuffer
    this.bufferOffset = 0

    if (this.flushing) {
      nextTick(() => this.joint!.end())
    }
  }

  callback() {
    if (!this.hasReadable) {
      return
    }

    const buffer = this.readSide.read()

    if (buffer !== null) {
      this.buffer = buffer
      this.bufferOffset = 0

      this.joint?.readable(buffer.byteLength, true)

    } else {
      this.hasReadable = false
    }
  }

  private streamReadable() {
    const readable = this.readable()
    this.hasReadable = true

    if (readable !== 0) {
      return
    }

    this.callback()
  }

  private streamEnd() {
    const readable = this.readable()

    if (readable !== 0 || this.joint === undefined) {
      this.flushing = true
    } else {
      this.joint!.end()
    }
  }
}

export interface ValveOptions {
  // Whether the end() of a read-side should be propagated to the write-side
  // after writing has finished. Default is true.
  end?: boolean
  // To be invoked once all data to the write-side has been written
  // and end() invoked on the write-side if applicable.
  endCallback?: () => void
}

export class Valve implements PipeJoint {

  readonly blockSize: number

  private readonly endWriter: boolean
  private readonly endCallback: () => void

  private readOntoBuffer = emptyBuffer
  private readOntoBufferOffset = 0

  private writeFromBuffer = emptyBuffer
  private remainder: Buffer | void = undefined

  private readonly filledBuffers: Buffer[] = []
  private readonly freeBlockBuffers: Buffer[] = []

  private readableAmount = 0
  private readBuffered = false

  private resumed = false
  private resumeAcquirable = false
  private resumeWith = emptyBuffer

  private writing = false
  private flushing = false

  constructor(
    private readonly readSide: ReadablePipe,
    private readonly writeSide: WritablePipe,
    options?: ValveOptions
  ) {
    const { end = true, endCallback = () => {} } = options ?? {}
    this.endWriter = end
    this.endCallback = endCallback
    const blockSize = writeSide.writableHighWaterMark - 1
    this.blockSize = blockSize
    this.readOntoBuffer = Buffer.allocUnsafe(blockSize)
    this.writeFromBuffer = Buffer.allocUnsafe(blockSize)
    readSide.start(this)
  }

  resume() {
    this.resumed = true

    const buffer = this.resumeWith

    if (buffer.byteLength !== 0) {
      this.resumeWith = emptyBuffer
      this.performWrite(buffer, this.resumeAcquirable)
    } else if (this.flushing) {
      this.close()
    }
  }

  readable(bufferLength: number, readBuffered = false) {
    const filledBuffers = this.filledBuffers

    if (filledBuffers.length !== 0) {
      this.readableAmount = bufferLength
      this.readBuffered = readBuffered
      return
    }

    const blockSize = this.blockSize
    const readOntoBufferOffset = this.readOntoBufferOffset

    if (readOntoBufferOffset === 0) {
      var remainder = this.remainder

      if (remainder !== undefined) {
        remainder.copy(this.readOntoBuffer)
        this.remainder = undefined
      } else if (
        readBuffered &&
        bufferLength >= 0 &&
        bufferLength <= blockSize
      ) {
        var readSide = this.readSide!
        var buf = readSide.read()

        if (bufferLength === blockSize) {
          if (!this.writing) {
            this.write(buf, true)
            this.freeBlockBuffers.push(this.writeFromBuffer)
            this.writeFromBuffer = buf
            readSide.callback()
          } else {
            this.filledBuffers.push(buf)
          }
        } else {
          if (!this.writing) {
            this.write(buf, true)
            // Nb. the buf is not large enough to become a writeFromBuffer
          } else {
            this.remainder = buf
          }
          readSide.callback()
        }

        return
      }
    }

    var readSide = this.readSide!
    const readOntoBuffer = this.readOntoBuffer
    var bufferOffset = blockSize - readOntoBufferOffset

    if (bufferLength < 0) {
      readSide.readOnto(
        readOntoBuffer,
        readOntoBufferOffset,
        bufferOffset,
        amount => {
          if (amount === bufferOffset) {
            if (this.writing) {
              this.filledBuffers.push(readOntoBuffer)
              this.readOntoBuffer = this.acquireBlockBuffer()
              this.readOntoBufferOffset = 0
            } else {
              this.write(readOntoBuffer)
              var readOntoBuffer2 = this.writeFromBuffer
              this.readOntoBuffer = readOntoBuffer2
              this.writeFromBuffer = readOntoBuffer

              readSide.readOnto(readOntoBuffer2, 0, blockSize, amount2 => {
                if (amount2 === blockSize) {
                  this.filledBuffers.push(readOntoBuffer2)
                  this.readOntoBuffer = this.acquireBlockBuffer()
                  this.readOntoBufferOffset = 0
                } else {
                  this.readOntoBufferOffset = amount2
                  readSide.callback()
                }
              })
            }
          } else if (amount !== 0) {
            if (!this.writing) {
              this.write(readOntoBuffer.slice(0, readOntoBufferOffset + amount))
              this.readOntoBuffer = this.writeFromBuffer
              this.writeFromBuffer = readOntoBuffer
              this.readOntoBufferOffset = 0
            } else {
              this.readOntoBufferOffset += amount
            }
            readSide.callback()
          }
        }
      )
    } else {
      var totalBufferData = readOntoBufferOffset + bufferLength

      if (totalBufferData >= blockSize) {
        readSide.readOnto(
          readOntoBuffer,
          readOntoBufferOffset,
          bufferOffset,
          _ => {
            var readOntoBuffer2: Buffer

            if (totalBufferData >= blockSize + blockSize) {
              var last = bufferLength - blockSize
              while (bufferOffset <= last) {
                bufferOffset += blockSize
                filledBuffers.push(readSide.read(blockSize))
              }

              readOntoBuffer2 = this.acquireBlockBuffer()
              var bufferLength2 = bufferLength - bufferOffset
              readSide.readOnto(readOntoBuffer2, 0, bufferLength2, _ => {
                this.readOntoBuffer = readOntoBuffer2
                this.readOntoBufferOffset = bufferLength2

                if (!this.writing) {
                  this.write(readOntoBuffer)
                  this.writeFromBuffer = readOntoBuffer
                }
              })
            } else {
              if (this.writing) {
                filledBuffers.push(readOntoBuffer)
                readOntoBuffer2 = this.acquireBlockBuffer()
              } else {
                this.write(readOntoBuffer)
                readOntoBuffer2 = this.writeFromBuffer
                this.writeFromBuffer = readOntoBuffer
              }

              var bufferLength2 = bufferLength - bufferOffset

              readSide.readOnto(readOntoBuffer2, 0, bufferLength2, _ => {
                this.readOntoBuffer = readOntoBuffer2
                this.readOntoBufferOffset = bufferLength2

                if (filledBuffers.length === 0) {
                  readSide.callback()
                }
              })
            }
          }
        )
      } else {
        readSide.readOnto(
          readOntoBuffer,
          readOntoBufferOffset,
          bufferLength,
          _ => {
            if (this.writing) {
              this.readOntoBufferOffset = totalBufferData
            } else {
              this.write(readOntoBuffer.slice(0, totalBufferData))
              this.readOntoBuffer = this.writeFromBuffer
              this.writeFromBuffer = readOntoBuffer
              this.readOntoBufferOffset = 0
            }

            readSide.callback()
          }
        )
      }
    }
  }

  private close() {
    if (this.endWriter) {
      this.writeSide.end()
    }
    this.endCallback()
  }

  end() {
    if (!this.resumed || this.writing) {
      this.flushing = true
    } else {
      this.close()
    }
  }

  private acquireBlockBuffer(): Buffer {
    if (this.freeBlockBuffers.length !== 0) {
      return this.freeBlockBuffers.pop()!
    }
    return Buffer.allocUnsafe(this.blockSize)
  }

  private write(buffer: Buffer, readBuffered = false) {
    this.writing = true

    if (!this.resumed) {
      this.resumeAcquirable = readBuffered
      this.resumeWith = buffer
      return
    }

    this.performWrite(buffer, readBuffered)
  }

  private performWrite(buffer: Buffer, readBuffered = false) {
    if (readBuffered) {
      this.writeSide.write(buffer, undefined, () => this.written())
    } else {
      this.writeSide.write(buffer, () => this.written())
    }
  }

  private written() {
    const filledBuffers = this.filledBuffers
    const existingFilledBuffers = filledBuffers.length

    if (existingFilledBuffers !== 0) {
      var filledBuffer = filledBuffers.shift()!
      var unfilled = existingFilledBuffers === 1
      var readableAmount = this.readableAmount

      if (unfilled && readableAmount !== 0) {
        var readBuffered = this.readBuffered
        this.readableAmount = 0
        this.readBuffered = false
        this.readable(readableAmount, readBuffered)
      }

      this.write(filledBuffer)
      this.freeBlockBuffers.push(this.writeFromBuffer)
      this.writeFromBuffer = filledBuffer

      if (unfilled) {
        this.readSide.callback()
      }
      return
    }

    const readOntoBufferOffset = this.readOntoBufferOffset

    if (readOntoBufferOffset !== 0) {
      var readOntoBuffer = this.readOntoBuffer

      this.write(readOntoBuffer.slice(0, readOntoBufferOffset))

      this.readOntoBuffer = this.writeFromBuffer
      this.writeFromBuffer = readOntoBuffer
      this.readOntoBufferOffset = 0
      return
    }

    const remainder = this.remainder
    if (remainder !== undefined) {
      this.write(remainder)
      this.remainder = undefined
      return
    }

    this.writing = false

    if (this.flushing) {
      this.close()
    }
  }
}
