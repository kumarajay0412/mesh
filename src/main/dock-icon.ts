// macOS dock icon from the Mesh mark (user-provided SVG): rendered once via an
// offscreen window (Chromium is our SVG rasterizer — no image deps), cached as
// PNG under userData, then app.dock.setIcon. Failure-safe: any error just
// leaves the default Electron icon. Packaged builds get a real .icns later.
import { app, BrowserWindow, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log } from './log'

const l = log('dock')

const MARK = `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M6.5 3.25H19.5M6.5 22.75H19.5M7.58333 3.25C7.58333 8.66667 12.4583 10.2917 13 13M13 13C13.5417 10.2917 18.4167 8.66667 18.4167 3.25M13 13C12.4583 15.7083 7.58333 17.3333 7.58333 22.75M13 13C13.5417 15.7083 18.4167 17.3333 18.4167 22.75" stroke="#F5C518" stroke-width="1.89583" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const PAGE = `<!doctype html><html><body style="margin:0">
<div style="width:512px;height:512px;background:#0e0e0e;border-radius:96px;display:grid;place-items:center">
  <div style="width:320px;height:320px">${MARK.replace('width="26" height="26"', 'width="320" height="320"')}</div>
</div></body></html>`

export async function setDockIcon(): Promise<void> {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    const cache = join(app.getPath('userData'), 'dock-icon.png')
    if (!existsSync(cache)) {
      const win = new BrowserWindow({
        width: 512,
        height: 512,
        show: false,
        frame: false,
        transparent: true,
        webPreferences: { offscreen: true },
      })
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
      await new Promise((r) => setTimeout(r, 150)) // let it paint
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
      win.destroy()
      await writeFile(cache, image.toPNG())
      l.info('dock icon rendered')
    }
    app.dock.setIcon(nativeImage.createFromBuffer(await readFile(cache)))
  } catch (e) {
    l.warn('dock icon skipped:', (e as Error).message)
  }
}
