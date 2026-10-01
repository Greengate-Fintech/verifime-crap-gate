// Not in the coverage file, so the gate lists it in crap/unmatched.tsv.
export function larger(a: number, b: number): number {
  if (a > b) {
    return a
  }
  if (b > a) {
    return b
  }
  return 0
}
