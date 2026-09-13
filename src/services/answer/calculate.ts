import { numbers } from "./verify-answer.js";
export function calculate(operation: string, operands: number[]): number {
  if (
    operands.length < 2 ||
    operands.length > 10 ||
    operands.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e12)
  )
    throw new Error("Invalid operands");
  const [first, ...rest] = operands;
  const operations: Record<string, (a: number, b: number) => number> = {
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    multiply: (a, b) => a * b,
    divide: (a, b) => a / b,
  };
  const fn = operations[operation];
  if (!fn) throw new Error("Unsupported calculation");
  const result = rest.reduce(fn, first!);
  if (!Number.isFinite(result)) throw new Error("Non-finite result");
  return Math.round(result * 1e8) / 1e8;
}

/** Arithmetic-only parser: numbers, parentheses and four operators; never executes code. */
export function calculateExpression(expression: string): {
  value: number;
  steps: string[];
  operands: number[];
} {
  if (expression.length > 200 || !/^[\d.\s()+*/-]+$/.test(expression))
    throw new Error("Invalid arithmetic expression");
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+*/-]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, ""))
    throw new Error("Invalid arithmetic token");
  let position = 0;
  const steps: string[] = [];
  const operands: number[] = [];
  const apply = (operator: string, left: number, right: number) => {
    const operation = (
      { "+": "add", "-": "subtract", "*": "multiply", "/": "divide" } as Record<
        string,
        string
      >
    )[operator]!;
    const value = calculate(operation, [left, right]);
    steps.push(`${left} ${operator} ${right} = ${value}`);
    return value;
  };
  const factor = (): number => {
    const token = tokens[position++];
    if (token === "(") {
      const value = sum();
      if (tokens[position++] !== ")")
        throw new Error("Missing closing parenthesis");
      return value;
    }
    if (token === "-") return -factor();
    if (!token || !/^\d/.test(token)) throw new Error("Expected a number");
    const value = Number(token);
    if (!Number.isFinite(value) || value > 1e12)
      throw new Error("Number exceeds calculator limit");
    operands.push(value);
    return value;
  };
  const product = (): number => {
    let value = factor();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++]!;
      value = apply(operator, value, factor());
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++]!;
      value = apply(operator, value, product());
    }
    return value;
  };
  const value = sum();
  if (position !== tokens.length || steps.length > 20)
    throw new Error("Invalid or excessive arithmetic");
  return { value, steps, operands };
}

/** Small cardinal words in user scenarios are inputs, never corpus claims. */
export function scenarioNumbers(text: string): number[] {
  const small: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    один: 1,
    одна: 1,
    одне: 1,
    два: 2,
    дві: 2,
    три: 3,
    чотири: 4,
    "п'ять": 5,
    шість: 6,
    сім: 7,
    вісім: 8,
    "дев'ять": 9,
    десять: 10,
    одинадцять: 11,
    дванадцять: 12,
  };
  return [
    ...numbers(text).map(Number),
    ...(
      text
        .toLowerCase()
        .replace(/’/g, "'")
        .match(/[\p{L}']+/gu) ?? []
    ).flatMap((token) => (small[token] !== undefined ? [small[token]!] : [])),
  ];
}
