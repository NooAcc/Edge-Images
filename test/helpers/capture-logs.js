export function createCaptureSink() {
  const lines = [];
  const sink = {
    info(line) {
      lines.push(line);
    },
    warn(line) {
      lines.push(line);
    },
    error(line) {
      lines.push(line);
    },
    log(line) {
      lines.push(line);
    }
  };

  return {
    sink,
    lines,
    records() {
      return lines.map(parseImageLogLine);
    }
  };
}

function parseImageLogLine(line) {
  const match = String(line).match(/^\[image\] (.+)$/);
  if (!match) {
    throw new Error(`Unexpected log line: ${line}`);
  }

  return JSON.parse(match[1]);
}
