/** Formats a count with a singular or plural noun, such as "1 test" or "3 tests". */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
