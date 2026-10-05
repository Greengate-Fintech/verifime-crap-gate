export interface Settings {
  alpha: number
  bravo: number
  charlie: number
  delta: number
  echo: number
  foxtrot: number
  golf: number
  hotel: number
  india: number
  juliet: number
  kilo: number
}

export function configure({
  alpha,
  bravo,
  charlie,
  delta,
  echo,
  foxtrot,
  golf,
  hotel,
  india,
  juliet,
  kilo,
}: Settings): number {
  return alpha + bravo + charlie + delta + echo + foxtrot + golf + hotel + india + juliet + kilo
}

export const describeSettings = async ({
  alpha,
  bravo,
  charlie,
  delta,
  echo,
  foxtrot,
  golf,
  hotel,
  india,
  juliet,
  kilo,
}: Settings): Promise<string> => {
  return `${alpha}${bravo}${charlie}${delta}${echo}${foxtrot}${golf}${hotel}${india}${juliet}${kilo}`
}

export const withDefault = (value: number, scale = (v: number) => v * 10): number => scale(value)

export const withUnusedDefault = (value: number, scale = (v: number) => v + 1): number => scale(value)
