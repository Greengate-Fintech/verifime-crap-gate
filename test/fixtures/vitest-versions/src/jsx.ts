export interface Element {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}

export const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
  type,
  props: props ?? {},
  children,
})
