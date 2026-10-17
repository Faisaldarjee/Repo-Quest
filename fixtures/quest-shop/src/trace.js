export function trace(event) {
  if (process.env.REPOQUEST_TRACE === "1") {
    process.stdout.write(`${JSON.stringify({ event })}\n`);
  }
}
