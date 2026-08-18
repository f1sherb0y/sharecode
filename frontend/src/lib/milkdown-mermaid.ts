import type { MilkdownPlugin } from '@milkdown/ctx'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import type { MarkdownNode } from '@milkdown/kit/transformer'
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils'

let uidCounter = 0

function generateId(): string {
  uidCounter += 1
  return `mmd-${Date.now().toString(36)}-${uidCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/**
 * Transforms fenced ` ```mermaid ` code blocks in the remark AST into a custom
 * `diagram` node so the schema below can create a ProseMirror diagram node.
 */
function transformMermaidTree(tree: MarkdownNode): void {
  const visit = (node: MarkdownNode | undefined | null): void => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'code' && (node as { lang?: string }).lang === 'mermaid') {
      node.type = 'diagram'
      delete (node as { lang?: unknown }).lang
      delete (node as { meta?: unknown }).meta
      return
    }
    const children = node.children as MarkdownNode[] | undefined
    if (Array.isArray(children)) {
      for (const child of children) visit(child)
    }
  }
  visit(tree)
}

class MermaidNodeView implements NodeView {
  dom: HTMLElement
  private node: ProseNode
  private readonly view: EditorView
  private readonly getPos: () => number | undefined
  private readonly identity: string
  private editing = false
  private renderToken = 0

  constructor(node: ProseNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.identity = node.attrs.identity || generateId()

    this.dom = document.createElement('div')
    this.dom.className = 'md-mermaid'
    this.dom.contentEditable = 'false'
    this.dom.setAttribute('data-type', 'diagram')
    this.render()

    this.dom.addEventListener('dblclick', () => this.startEditing())
  }

  private theme(): 'dark' | 'default' {
    return document.documentElement.getAttribute('data-theme') === 'dark'
      ? 'dark'
      : 'default'
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken
    const source = (this.node.attrs.value as string) || ''

    this.dom.innerHTML = ''
    const loading = document.createElement('div')
    loading.className = 'md-mermaid-loading'
    loading.textContent = 'Rendering diagram…'
    this.dom.appendChild(loading)

    try {
      const mermaid = (await import('mermaid')).default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: this.theme(),
      })
      const { svg } = await mermaid.render(this.identity, source)
      if (token !== this.renderToken) return

      this.dom.innerHTML = ''
      const container = document.createElement('div')
      container.className = 'md-mermaid-svg'
      container.innerHTML = svg
      this.dom.appendChild(container)
    } catch (error) {
      if (token !== this.renderToken) return
      this.dom.innerHTML = ''
      const pre = document.createElement('pre')
      pre.className = 'md-mermaid-source'
      pre.textContent = source
      const message = document.createElement('div')
      message.className = 'md-mermaid-error'
      message.textContent = error instanceof Error ? error.message : String(error)
      this.dom.append(pre, message)
    }
  }

  private startEditing(): void {
    if (this.editing || !this.view.editable) return
    this.editing = true
    this.renderToken += 1

    this.dom.innerHTML = ''
    const textarea = document.createElement('textarea')
    textarea.className = 'md-mermaid-editor'
    textarea.value = (this.node.attrs.value as string) || ''
    textarea.spellcheck = false
    this.dom.appendChild(textarea)
    textarea.focus()

    const commit = () => {
      if (!this.editing) return
      this.editing = false
      const pos = this.getPos()
      if (pos != null && this.view.editable) {
        this.view.dispatch(
          this.view.state.tr.setNodeAttribute(pos, 'value', textarea.value),
        )
      }
      this.render()
    }

    textarea.addEventListener('blur', commit)
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        textarea.blur()
      } else if (event.key === 'Escape') {
        this.editing = false
        this.render()
      }
    })
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    if (!this.editing) void this.render()
    return true
  }

  selectNode(): void {
    this.dom.classList.add('selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('selected')
  }

  stopEvent(): boolean {
    return true
  }

  destroy(): void {
    this.renderToken += 1
  }
}

const remarkDiagramPlugin = $remark('remarkMermaid', () => transformMermaidTree)

const diagramSchema = $nodeSchema('diagram', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  defining: true,
  marks: '',
  attrs: {
    value: { default: '' },
    identity: { default: '' },
  },
  parseDOM: [
    {
      tag: 'div[data-type="diagram"]',
      preserveWhitespace: 'full',
      getAttrs: (dom: unknown) => {
        const el = dom as HTMLElement
        return { value: el.dataset.value ?? '', identity: el.dataset.id ?? '' }
      },
    },
  ],
  toDOM: (node: ProseNode) => [
    'div',
    {
      'data-type': 'diagram',
      'data-value': node.attrs.value as string,
      'data-id': node.attrs.identity as string,
    },
    node.attrs.value as string,
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === 'diagram',
    runner: (state, node, type) => {
      state.addNode(type, {
        value: (node.value as string) ?? '',
        identity: generateId(),
      })
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === 'diagram',
    runner: (state, node) => {
      state.addNode('code', undefined, (node.attrs.value as string) || '', {
        lang: 'mermaid',
      })
    },
  },
}))

const diagramView = $view(
  diagramSchema.node,
  () =>
    (node: ProseNode, view: EditorView, getPos: () => number | undefined) =>
      new MermaidNodeView(node, view, getPos),
)

export const mermaidPlugins: MilkdownPlugin[] = [
  remarkDiagramPlugin,
  diagramSchema,
  diagramView,
].flat()
