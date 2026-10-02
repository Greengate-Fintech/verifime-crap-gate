export function discount(total: number, member: boolean, coupon: string): number {
  let rate = 0
  if (member) {
    rate += 0.1
  }
  if (coupon === 'SAVE5' && total > 50) {
    rate += 0.05
  }
  if (total > 500) {
    rate += 0.05
  }
  return total * (1 - rate)
}

export function label(value: number): string {
  return `$${value.toFixed(2)}`
}

export function tier(points: number): string {
  if (points > 1000) return 'gold'
  if (points > 100) return 'silver'
  return 'basic'
}
