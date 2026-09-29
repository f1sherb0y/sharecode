import type { MilkdownPlugin } from '@milkdown/ctx'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { InputRule, textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import { exitCode } from '@milkdown/kit/prose/commands'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@milkdown/kit/prose/view'
import { $inputRule, $nodeSchema, $prose, $remark, $useKeymap, $view } from '@milkdown/kit/utils'
import katex from 'katex'
import remarkMath from 'remark-math'

const remarkMathPlugin = $remark('remarkMath', () => remarkMath)

function mathSchema(name: 'math_inline' | 'math_block', inline: boolean) {
  const markdownType = inline ? 'inlineMath' : 'math'
  const tag = inline ? 'span' : 'div'
  return $nodeSchema(name, () => ({
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    code: true,
    content: 'text*',
    marks: '',
    parseDOM: [{
      tag: `${tag}[data-type="${name}"]`,
      contentElement: '[data-math-source]',
      preserveWhitespace: 'full',
    }],
    toDOM: () => [tag, { 'data-type': name }, [tag, { 'data-math-source': '' }, 0]],
    parseMarkdown: {
      match: (node) => node.type === markdownType,
      runner: (state, node, type) => {
        state.openNode(type)
        if (node.value) state.addText(node.value as string)
        state.closeNode()
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === name,
      runner: (state, node) => {
        state.addNode(markdownType, undefined, node.textContent)
      },
    },
  }))
}

const inlineMathSchema = mathSchema('math_inline', true)
const blockMathSchema = mathSchema('math_block', false)

class MathNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private preview: HTMLElement
  private node: ProseNode

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    const tag = node.isInline ? 'span' : 'div'
    this.dom = document.createElement(tag)
    this.dom.className = `md-math ${node.isInline ? 'md-math-inline' : 'md-math-block'}`
    this.dom.dataset.type = node.type.name

    this.preview = document.createElement(tag)
    this.preview.className = 'md-math-preview'
    this.preview.contentEditable = 'false'
    this.contentDOM = document.createElement(tag)
    this.contentDOM.className = 'md-math-source'
    this.contentDOM.dataset.mathSource = ''
    this.contentDOM.spellcheck = false
    this.dom.append(this.preview, this.contentDOM)
    this.render()

    this.preview.addEventListener('mousedown', (event) => {
      if (!view.editable || event.button !== 0) return
      const pos = getPos()
      if (pos == null) return
      event.preventDefault()
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)))
      view.focus()
    })
  }

  private render() {
    // Keep source as ProseMirror text so edits participate in Yjs collaboration.
    // KaTeX output is only a local, non-editable preview.
    katex.render(this.node.textContent, this.preview, {
      displayMode: !this.node.isInline,
      output: 'mathml',
      throwOnError: false,
      trust: false,
      strict: 'ignore',
    })
  }

  update(node: ProseNode) {
    if (node.type !== this.node.type) return false
    const changed = node.textContent !== this.node.textContent
    this.node = node
    if (changed) this.render()
    return true
  }

  ignoreMutation(mutation: Parameters<NonNullable<NodeView['ignoreMutation']>>[0]) {
    if (mutation.type === 'selection') return false
    return !this.contentDOM.contains(mutation.target)
  }
}

const inlineMathView = $view(inlineMathSchema.node, () =>
  (node, view, getPos) => new MathNodeView(node, view, getPos))
const blockMathView = $view(blockMathSchema.node, () =>
  (node, view, getPos) => new MathNodeView(node, view, getPos))

const inlineMathInputRule = $inputRule((ctx) => new InputRule(
  /(^|[^\\$])\$([^$\n]+)\$$/,
  (state, match, start, end) => {
    if (state.selection.$from.marks().some((mark) => mark.type.spec.code)) return null
    const source = match[2]
    if (!source) return null
    return state.tr.replaceWith(
      start + (match[1]?.length ?? 0), end,
      inlineMathSchema.type(ctx).create(null, state.schema.text(source)),
    )
  },
))

// Typing "$$ " starts an editable block; pasted multiline $$ fences are
// handled by remark-math, as are imported documents and playback snapshots.
const blockMathInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^\$\$\s$/, blockMathSchema.type(ctx)))

const mathEditing = $prose(() => new Plugin({
  props: {
    decorations(state) {
      const { $from, $to } = state.selection
      if ($from.parent !== $to.parent || !['math_inline', 'math_block'].includes($from.parent.type.name)) {
        return DecorationSet.empty
      }
      return DecorationSet.create(state.doc, [
        Decoration.node($from.before(), $from.after(), { class: 'md-math-editing' }),
      ])
    },
  },
}))

const mathKeymap = $useKeymap('mathKeymap', {
  StartBlockMath: {
    shortcuts: 'Enter',
    priority: 100,
    command: (ctx) => (state, dispatch, view) => {
      const { $from, empty } = state.selection
      if (!view?.editable || !empty || $from.parent.type.name !== 'paragraph' || $from.parent.textContent !== '$$') return false
      dispatch?.(state.tr.delete($from.start(), $from.end())
        .setBlockType($from.before(), $from.before(), blockMathSchema.type(ctx)))
      return true
    },
  },
  ExitMath: {
    shortcuts: ['Escape', 'Mod-Enter'],
    priority: 100,
    command: () => (state, dispatch, view) => {
      const { $from } = state.selection
      if (!view?.editable || !['math_inline', 'math_block'].includes($from.parent.type.name)) return false
      if ($from.parent.isInline) {
        dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, $from.after())))
        return true
      }
      return exitCode(state, dispatch)
    },
  },
})

export const mathPlugins: MilkdownPlugin[] = [
  remarkMathPlugin,
  inlineMathSchema,
  blockMathSchema,
  inlineMathView,
  blockMathView,
  inlineMathInputRule,
  blockMathInputRule,
  mathEditing,
  mathKeymap,
].flat()
