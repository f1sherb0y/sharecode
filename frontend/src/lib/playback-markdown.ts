import type * as Y from 'yjs'
import { Editor, editorViewOptionsCtx, rootCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { replaceAll } from '@milkdown/kit/utils'
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { mermaidPlugins } from './milkdown-mermaid'
import { imagePlugins } from './milkdown-image'
import { mathPlugins } from './milkdown-math'
import { loadEditorFont } from './editor-font'
import '@/styles/markdown.css'
import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'

export function createMarkdownPlayback(container: HTMLElement) {
  void loadEditorFont().catch(() => {})
  return Editor.make().config(ctx => {
    ctx.set(rootCtx, container)
    ctx.update(editorViewOptionsCtx, prev => ({ ...prev, editable: () => false }))
  }).use(commonmark).use(gfm).use(mermaidPlugins).use(imagePlugins).use(mathPlugins)
}
export function getMarkdown(doc: Y.Doc, editor: Editor) {
  if (doc.getMap('meta').get('markdownInitialized') || doc.getXmlFragment('prosemirror').length > 0) {
    return editor.action(ctx => ctx.get(serializerCtx)(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment('prosemirror'), ctx.get(schemaCtx))))
  }
  return doc.getText('codemirror').toString()
}
export function replaceMarkdown(editor: Editor, text: string) { editor.action(replaceAll(text)) }
