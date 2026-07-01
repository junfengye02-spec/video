import type { Shot } from "./types";

export function orderedShots(shots: Shot[]): Shot[] {
  return [...shots].sort((left, right) => left.index - right.index);
}
