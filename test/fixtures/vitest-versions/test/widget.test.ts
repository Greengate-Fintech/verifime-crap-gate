import { expect, it, vi } from 'vitest'
import { Widget } from '../src/Widget'

it('renders the widget and fires its handler', () => {
  const onPick = vi.fn()
  const el = Widget({ title: 't', count: 3, onPick })
  ;(el.props.onClick as () => void)()
  expect(onPick).toHaveBeenCalledWith(3)
})
