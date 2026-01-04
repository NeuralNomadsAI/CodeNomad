import { Component } from "solid-js"
import { BookOpen } from "lucide-solid"

/**
 * Small book icon button displayed on message blocks with markdown files
 * Triggers preview modal when clicked
 */

interface MarkdownPreviewIconProps {
  // Path to the markdown file
  filePath: string

  // Callback when icon is clicked to open preview
  onOpenPreview: (filePath: string) => void

  // Optional CSS class for positioning/styling
  className?: string

  // Tooltip text (defaults to "Preview {filename}")
  tooltip?: string

  // Icon size in pixels (default: 18)
  size?: number
}

/**
 * MarkdownPreviewIcon Component
 * 
 * Renders a small book icon button that opens markdown file preview.
 * Shows filename on hover via tooltip.
 * 
 * @example
 * <MarkdownPreviewIcon
 *   filePath="docs/guide.md"
 *   onOpenPreview={(path) => openModal(path)}
 * />
 */
const MarkdownPreviewIcon: Component<MarkdownPreviewIconProps> = (props) => {
  const iconSize = () => props.size ?? 18
  const tooltipText = () => {
    if (props.tooltip) return props.tooltip
    const filename = props.filePath.split("/").pop() || props.filePath
    return `Preview ${filename}`
  }

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation() // Prevent message selection
    props.onOpenPreview(props.filePath)
  }

  return (
    <button
      class={`markdown-preview-icon ${props.className || ""}`}
      onClick={handleClick}
      title={tooltipText()}
      aria-label={`Preview markdown file: ${props.filePath}`}
      type="button"
    >
      <BookOpen
        size={iconSize()}
        class="markdown-preview-icon-inner"
        stroke-width={1.5}
      />
    </button>
  )
}

export default MarkdownPreviewIcon
