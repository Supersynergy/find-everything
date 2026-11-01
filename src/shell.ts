export function shellCommand(args: string[]): string {
  return args.map(value => `'${value.replace(/'/g, "'\\''")}'`).join(" ");
}
