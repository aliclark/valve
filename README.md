# valve

An extremely low-overhead alternative to pipe() in Node.js

* Implements backpressure
* Minimises `write` calls by buffering up to the maximum buffer size
* Minimises copies
    * Transfers ownership of existing buffers where possible
    * Writes directly to destination buffers
* Eagerly fills write buffers even before writing commences

## Usage

Writing to an HTTP response body

```typescript
import type { ReadablePipe } from '@aliclark/valve'
import { Valve } from '@aliclark/valve'
class MyReadablePipe implements ReadablePipe { /* implement readOnto method, callback for retrieval, etc */ }
const readablePipe = new MyReadablePipe(() => { /* find more data */ })
// starts preparing the valve's internal buffer with data from readablePipe
const valve = new Valve(readablePipe, res, { end: false, endCallback: () => { /* finished */ } })
// at a moment of your choosing, start writing to the response
valve.resume()
```

Reading from an HTTP response body

```typescript
import { Valve, ReadableStreamPipe } from '@aliclark/valve'
const valve = new Valve(new ReadableStreamPipe(req), writable)
valve.resume()
```

Transforming TCP stream data

```typescript
import type { Transformer } from '@aliclark/valve'
import { Valve, ReadableStreamPipe, TransformerPipe } from '@aliclark/valve'
class MyTransformer implements Transformer { /* implement transform method */ }
const conn = net.createConnection({ port, host, allowHalfOpen: true }, () => { /* connected */ })
const transformerPipe = new TransformerPipe(new MyTransformer(), conn.writableHighWaterMark - 1)
const input = new Valve(new ReadableStreamPipe(conn), transformerPipe)
const output = new Valve(transformerPipe, conn)
input.resume()
output.resume()
```
