import { Show } from "solid-js"
import { Maximize2, Minimize2 } from "lucide-solid"
import { useI18n } from "../lib/i18n"

interface ExpandButtonProps {
  /**
   * Current height of the input container in pixels.
   * Used to determine which icon to show (expand vs shrink).
   */
  currentHeight: () => number
  /**
   * Default/minimum height of the input container in pixels.
   * When currentHeight exceeds this, the shrink icon is shown.
   */
  defaultHeight: () => number
  /**
   * Callback when the button is clicked.
   * true = expand to default expanded height, false = shrink to default height
   */
  onToggleExpand: (expand: boolean) => void
}

/**
 * Expand/shrink button for the prompt input.
 * Shows expand icon when at default height, shrink icon when enlarged.
 * Clicking toggles between default and expanded heights.
 */
export default function ExpandButton(props: ExpandButtonProps) {
  const { t } = useI18n()

  /**
   * Determines if the input is currently expanded based on actual height.
   * Returns true when current height exceeds the default height.
   */
  const isExpanded = () => props.currentHeight() > props.defaultHeight()

  /**
   * Handles button click by toggling between expanded and collapsed states.
   * Passes true to expand, false to shrink.
   */
  function handleClick() {
    props.onToggleExpand(!isExpanded())
  }

  return (
    <button
      type="button"
      class="prompt-expand-button"
      onClick={handleClick}
      aria-label={t("expandButton.toggleAriaLabel")}
    >
      <Show
        when={!isExpanded()}
        fallback={<Minimize2 class="h-4 w-4" aria-hidden="true" />}
      >
        <Maximize2 class="h-4 w-4" aria-hidden="true" />
      </Show>
    </button>
  )
}
