// The served page (issue 0016). esbuild inlines page.html as a string, so the
// bundle stays one file.
import page from './page.html'

export const PAGE: string = page
