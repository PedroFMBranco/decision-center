import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** A JSON file written whole: a temp file in the same folder, then a rename. */
export function jsonFile(path: string): { load(): Promise<unknown>; save(value: unknown): Promise<void> } {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw error
      }
    },
    async save(value) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`)
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, path)
    }
  }
}
