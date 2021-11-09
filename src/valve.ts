import { nextTick } from 'process'
import { Readable } from 'stream'

export interface ReadablePipe {
  start(joint: PipeJoint): void
  readable(): number
  acquirable(): boolean
  // This is liable to return 0 length if not acquirable, or async work is needed
  read(size?: number): Buffer
  readOnto(
    target: Buffer,
    offset: number,
    size: number,
    callback: (amount: number) => void,
  ): void
  callback(): void
}

export interface WritablePipe {
  readonly writableHighWaterMark: number
  write(target: Buffer, callback: () => void): void
  // use undefined as the second argument to signal the target is acquirable
  write(target: Buffer, _: undefined, callback: () => void): void
  end(): void
}

export interface PipeJoint {
  readonly blockSize: number
  // invoked by the program to start writing of data to the write-side
  resume(): void
  // invoked by the read-side when new data becomes available
  readable(size: number, acquirable: boolean): void
  // invoked by the read-side once all data is consumed and no more data is available
  end(): void
}

export interface Transformer {
  transform(
    source: Buffer,
    target: Buffer,
    targetStart: number,
    targetEnd: number,
    sourceStart: number,
    sourceEnd: number,
    callback: (consumed: number, written: number) => void,
  ): void
}

export class PassThroughTransformer implements Transformer {
  transform(
    source: Buffer,
    target: Buffer,
    targetStart: number,
    targetEnd: number,
    sourceStart: number,
    sourceEnd: number,
    callback: (consumed: number, written: number) => void,
  ): void {
    const amount = Math.min(targetEnd - targetStart, sourceEnd - sourceStart)
    source.copy(target, targetStart, sourceStart, sourceStart + amount)
    callback(amount, amount)
  }
}

export const passThroughTransformer = new PassThroughTransformer()

export class TransformerPipe implements ReadablePipe, WritablePipe {
  private static readonly emptyBuffer = Buffer.allocUnsafe(0)

  readonly writableHighWaterMark: number

  private joint: PipeJoint | void = undefined
  private writeFinished: Function = () => {}

  private remainderIsAcquirable = false
  private remainder = TransformerPipe.emptyBuffer
  private remainderOffset = 0

  private buffer = TransformerPipe.emptyBuffer
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
    return -1
  }

  acquirable(): boolean {
    return false
  }

  readOnto(
    target: Buffer,
    offset: number,
    askSize: number,
    callback: (amount: number) => void,
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
      },
    )
  }

  read() {
    return TransformerPipe.emptyBuffer
  }

  private reset() {
    this.buffer = TransformerPipe.emptyBuffer
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
    console.log(`transformer.write(${target.byteLength})`)

    var isAcquirable = false

    if (this.remainderOffset !== this.remainder.byteLength) {
      this.buffer = Buffer.concat([
        this.remainder.slice(this.remainderOffset),
        target,
      ])
      this.remainder = TransformerPipe.emptyBuffer
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
    console.log('transformer.end()')
    if (this.buffer.byteLength !== 0 || this.joint === undefined) {
      this.flushing = true
    } else {
      this.joint!.end()
    }
  }
}

export class ReadableStreamPipe implements ReadablePipe {
  private static readonly emptyBuffer = Buffer.allocUnsafe(0)

  private joint: PipeJoint | void = undefined

  private buffer = ReadableStreamPipe.emptyBuffer
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
    callback: (amount: number) => void,
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
    this.buffer = ReadableStreamPipe.emptyBuffer
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
      console.log(`readableStream.read() => ${buffer.byteLength}`)
      this.buffer = buffer
      this.bufferOffset = 0

      this.joint?.readable(buffer.byteLength, true)
    } else {
      console.log(`readableStream.read() => null`)
      this.hasReadable = false
    }
  }

  private streamReadable() {
    console.log(`readableStream event:readable`)
    const readable = this.readable()
    this.hasReadable = true

    if (readable !== 0) {
      return
    }

    this.callback()
  }

  private streamEnd() {
    console.log(`readableStream event:end`)

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
  private static readonly emptyBuffer = Buffer.allocUnsafe(0)

  readonly blockSize: number

  private readonly endWriter: boolean
  private readonly endCallback: () => void

  private readOntoBuffer = Valve.emptyBuffer
  private readOntoBufferOffset = 0

  private writeFromBuffer = Valve.emptyBuffer
  private remainder: Buffer | void = undefined

  private readonly filledBuffers: Buffer[] = []
  private readonly freeBlockBuffers: Buffer[] = []

  private readableAmount = 0
  private readBuffered = false

  private resumed = false
  private resumeAcquirable = false
  private resumeWith = Valve.emptyBuffer

  private writing = false
  private flushing = false

  constructor(
    private readonly readSide: ReadablePipe,
    private readonly writeSide: WritablePipe,
    options?: ValveOptions,
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
      this.resumeWith = Valve.emptyBuffer
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
        (amount) => {
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

              readSide.readOnto(readOntoBuffer2, 0, blockSize, (amount2) => {
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
        },
      )
    } else {
      var totalBufferData = readOntoBufferOffset + bufferLength

      if (totalBufferData >= blockSize) {
        readSide.readOnto(
          readOntoBuffer,
          readOntoBufferOffset,
          bufferOffset,
          (_) => {
            var readOntoBuffer2: Buffer

            if (totalBufferData >= blockSize + blockSize) {
              var last = bufferLength - blockSize
              while (bufferOffset <= last) {
                bufferOffset += blockSize
                filledBuffers.push(readSide.read(blockSize))
              }

              readOntoBuffer2 = this.acquireBlockBuffer()
              var bufferLength2 = bufferLength - bufferOffset
              readSide.readOnto(readOntoBuffer2, 0, bufferLength2, (_) => {
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

              readSide.readOnto(readOntoBuffer2, 0, bufferLength2, (_) => {
                this.readOntoBuffer = readOntoBuffer2
                this.readOntoBufferOffset = bufferLength2

                if (filledBuffers.length === 0) {
                  readSide.callback()
                }
              })
            }
          },
        )
      } else {
        readSide.readOnto(
          readOntoBuffer,
          readOntoBufferOffset,
          bufferLength,
          (_) => {
            if (this.writing) {
              this.readOntoBufferOffset = totalBufferData
            } else {
              this.write(readOntoBuffer.slice(0, totalBufferData))
              this.readOntoBuffer = this.writeFromBuffer
              this.writeFromBuffer = readOntoBuffer
              this.readOntoBufferOffset = 0
            }

            readSide.callback()
          },
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
