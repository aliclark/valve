import { PassThrough, Readable } from 'stream'
import { Valve, ReadableStreamPipe } from './valve'

describe('Valve', () => {
  // TODO: Get to 100% logic coverage :-)

  it('works as a pass-through', done => {
    const readSide = new ReadableStreamPipe(
      Readable.from([Buffer.from('abc')], { objectMode: false })
    )
    const writeSide = new PassThrough()
    const socket = new Valve(readSide, writeSide)
    socket.resume()

    const buffers: Buffer[] = []
    writeSide.on('readable', () => {
      const data = writeSide.read()
      if (data !== null) {
        buffers.push(data)
      }
    })
    writeSide.on('end', () => {
      expect(Buffer.concat(buffers).toString()).toBe('abc')
      done()
    })
  })
})
