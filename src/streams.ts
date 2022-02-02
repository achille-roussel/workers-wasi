import * as wasi from './snapshot_preview1'

export interface FileDescriptor {
  writev(iovs: Array<Uint8Array>): Promise<number> | number
  readv(iovs: Array<Uint8Array>): Promise<number> | number
  close(): Promise<void> | void

  preRun(): Promise<void>
  postRun(): Promise<void>
}

class DevNull implements FileDescriptor {
  writev(iovs: Array<Uint8Array>): number {
    return iovs.map((iov) => iov.byteLength).reduce((prev, curr) => prev + curr)
  }

  readv(iovs: Array<Uint8Array>): number {
    return 0
  }

  close(): void {}

  async preRun(): Promise<void> {}
  async postRun(): Promise<void> {}
}

class ReadableStreamBase {
  writev(iovs: Array<Uint8Array>): number {
    throw new Error('Attempting to call write on a readable stream')
  }

  close(): void {}

  async preRun(): Promise<void> {}
  async postRun(): Promise<void> {}
}

class AsyncReadableStreamAdapter
  extends ReadableStreamBase
  implements FileDescriptor
{
  #pending = new Uint8Array()
  #reader: ReadableStreamDefaultReader

  constructor(reader: ReadableStreamDefaultReader) {
    super()
    this.#reader = reader
  }

  async readv(iovs: Array<Uint8Array>): Promise<number> {
    let read = 0
    for (const buffer of iovs) {
      let expected = buffer.byteLength
      read += this.consumeInto(buffer, read)
      while (read < expected) {
        const result = await this.#reader.read()
        if (result.done) {
          return read
        }
        this.#pending = new Uint8Array(result.value)
        read += this.consumeInto(buffer, read)
        break
      }
    }
    return read
  }

  private consumeInto(buffer: Uint8Array, offset: number): number {
    if (!this.#pending.byteLength) {
      return 0
    }

    const bytesToConsume = Math.min(
      buffer.byteLength - offset,
      this.#pending.byteLength
    )
    buffer.set(this.#pending.slice(0, bytesToConsume), offset)
    this.#pending = this.#pending.slice(bytesToConsume)
    return bytesToConsume
  }
}

class WritableStreamBase {
  readv(iovs: Array<Uint8Array>): number {
    throw new Error('Attempting to call read on a writable stream')
  }

  close(): void {}

  async preRun(): Promise<void> {}
  async postRun(): Promise<void> {}
}

class AsyncWritableStreamAdapter
  extends WritableStreamBase
  implements FileDescriptor
{
  #writer: WritableStreamDefaultWriter

  constructor(writer: WritableStreamDefaultWriter) {
    super()
    this.#writer = writer
  }

  async writev(iovs: Array<Uint8Array>): Promise<number> {
    let written = 0
    for (const iov of iovs) {
      if (iov.byteLength === 0) {
        continue
      }
      await this.#writer.write(iov)
      written += iov.byteLength
    }
    return written
  }

  async close(): Promise<void> {
    await this.#writer.close()
  }
}

class SyncWritableStreamAdapter
  extends WritableStreamBase
  implements FileDescriptor
{
  #writer: WritableStreamDefaultWriter
  #buffer: Uint8Array = new Uint8Array(4096)
  #bytesWritten: number = 0

  constructor(writer: WritableStreamDefaultWriter) {
    super()
    this.#writer = writer
  }

  writev(iovs: Array<Uint8Array>): number {
    let written = 0
    for (const iov of iovs) {
      if (iov.byteLength === 0) {
        continue
      }

      // Check if we're about to overflow the buffer and resize if need be.
      if (this.#bytesWritten + iov.byteLength > this.#buffer.byteLength) {
        const oldBuffer = this.#buffer
        this.#buffer = new Uint8Array(this.#buffer.length * 2)
        this.#buffer.set(oldBuffer)
      }

      this.#buffer.set(iov, this.#bytesWritten)
      written += iov.byteLength
      this.#bytesWritten += iov.byteLength
    }
    return written
  }

  async postRun(): Promise<void> {
    const slice = this.#buffer.subarray(0, this.#bytesWritten)
    await this.#writer.write(slice)
    await this.#writer.close()
  }
}

class SyncReadableStreamAdapter
  extends ReadableStreamBase
  implements FileDescriptor
{
  #buffer?: Uint8Array
  #reader: ReadableStreamDefaultReader

  constructor(reader: ReadableStreamDefaultReader) {
    super()
    this.#reader = reader
  }

  readv(iovs: Array<Uint8Array>): number {
    let read = 0
    for (const buffer of iovs) {
      let expected = buffer.byteLength
      read += this.consumeInto(buffer, read)
    }
    return read
  }

  async preRun(): Promise<void> {
    const pending: Array<Uint8Array> = []
    let length = 0

    for (;;) {
      const result = await this.#reader.read()
      if (result.done) {
        break
      }

      const data = result.value
      pending.push(data)
      length += data.length
    }

    let result = new Uint8Array(length)
    let offset = 0

    pending.forEach((item) => {
      result.set(item, offset)
      offset += item.length
    })

    this.#buffer = result
  }

  private consumeInto(buffer: Uint8Array, offset: number): number {
    if (!this.#buffer!.byteLength) {
      return 0
    }

    const bytesToConsume = Math.min(
      buffer.byteLength - offset,
      this.#buffer!.byteLength
    )
    buffer.set(this.#buffer!.slice(0, bytesToConsume), offset)
    this.#buffer = this.#buffer!.slice(bytesToConsume)
    return bytesToConsume
  }
}

export const fromReadableStream = (
  stream: ReadableStream | undefined,
  supportsAsync: boolean
): FileDescriptor => {
  if (!stream) {
    return new DevNull()
  }

  if (supportsAsync) {
    return new AsyncReadableStreamAdapter(stream.getReader())
  }

  return new SyncReadableStreamAdapter(stream.getReader())
}

export const fromWritableStream = (
  stream: WritableStream | undefined,
  supportsAsync: boolean
): FileDescriptor => {
  if (!stream) {
    return new DevNull()
  }

  if (supportsAsync) {
    return new AsyncWritableStreamAdapter(stream.getWriter())
  }

  return new SyncWritableStreamAdapter(stream.getWriter())
}
