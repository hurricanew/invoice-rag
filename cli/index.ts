#!/usr/bin/env -S node --experimental-strip-types

const [, , command] = process.argv;

async function main() {
  switch (command) {
    default:
      console.log("ap-rag-agent CLI — commands not yet implemented (see tasks.md A7)");
      console.log("Usage: npm run cli -- <start-run|get-run|approve|reject|list-evaluations>");
  }
}

main();
