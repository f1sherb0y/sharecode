import type { MilkdownPlugin } from '@milkdown/ctx'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { NodeView } from '@milkdown/kit/prose/view'
import { imageSchema } from '@milkdown/kit/preset/commonmark'
import { $view } from '@milkdown/kit/utils'

/**
 * Custom node view for the inline `image` node. It wraps the <img> in a
 * <span class="md-image"> so that remote-selection decorations (which apply
 * their class/style to the node's top-level DOM) can overlay a colored mask
 * on top of the image via a CSS `::after` pseudo-element.
 *
 * Without the wrapper, the decoration lands directly on a bare <img>, where a
 * background-color paints *behind* the opaque image and is invisible.
 */
class ImageNodeView implements NodeView {
  dom: HTMLElement
  private readonly img: HTMLImageElement

  constructor(node: ProseNode) {
    this.dom = document.createElement('span')
    this.dom.className = 'md-image'

    this.img = document.createElement('img')
    this.dom.appendChild(this.img)
    this.update(node)
  }

  update(node: ProseNode): boolean {
    if (node.type.name !== 'image') return false
    const nextSrc = (node.attrs.src as string) ?? ''
    const nextAlt = (node.attrs.alt as string) ?? ''
    if (this.img.src !== nextSrc) this.img.src = nextSrc
    if (this.img.alt !== nextAlt) this.img.alt = nextAlt
    return true
  }

  stopEvent(): boolean {
    return true
  }

  selectNode(): void {
    this.dom.classList.add('selected')
  }

  deselectNode(): void {
    this.dom.classList.remove('selected')
  }
}

const imageView = $view(imageSchema.node, () => (node: ProseNode) => new ImageNodeView(node))

export const imagePlugins: MilkdownPlugin[] = [imageView]
