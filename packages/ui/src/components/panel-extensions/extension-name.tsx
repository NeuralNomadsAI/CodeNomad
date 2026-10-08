import { Tooltip } from "@kobalte/core/tooltip"

export function ExtensionName(props: { name: string; version: string; details: string }) {
  return <Tooltip placement="top-start" openDelay={300}>
    <Tooltip.Trigger as="span" tabindex="0" class="panel-extension-name">
      {props.name} <small>{props.version}</small>
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content class="section-info-tooltip panel-extension-tooltip">{props.details}</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip>
}
