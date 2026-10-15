const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Anonymous labels: member:A to member:Z, then member:AA and on. */
export function memberLabel(index: number): string {
  let name = "";
  let rest = index;
  do {
    name = (LETTERS[rest % LETTERS.length] ?? "") + name;
    rest = Math.floor(rest / LETTERS.length) - 1;
  } while (rest >= 0);
  return `member:${name}`;
}

export function messageId(index: number): string {
  return `m${String(index + 1).padStart(4, "0")}`;
}
