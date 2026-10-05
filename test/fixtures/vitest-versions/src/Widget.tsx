/** @jsxRuntime classic */
/** @jsx h */
import { h } from './jsx'

export interface WidgetProps {
  title: string
  count: number
  onPick: (n: number) => void
  disabled?: boolean
  variant?: string
  footer?: string
  icon?: string
  tooltip?: string
  testId?: string
  ariaLabel?: string
}

export const Widget = ({
  title,
  count,
  onPick,
  disabled,
  variant,
  footer,
  icon,
  tooltip,
  testId,
  ariaLabel,
}: WidgetProps) => {
  return (
    <button aria-label={ariaLabel} data-testid={testId} disabled={disabled} onClick={() => onPick(count)} title={tooltip}>
      {icon}
      {title}
      {variant}
      {footer}
    </button>
  )
}

export const Unused = ({ text }: { text: string }) => <span onClick={() => text}>{text}</span>
