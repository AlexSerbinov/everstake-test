export function calculate(operation: string, operands: number[]): number {
 if (operands.length < 2 || operands.length > 10 || operands.some(n=>!Number.isFinite(n)||Math.abs(n)>1e12)) throw new Error('Invalid operands');
 const [first,...rest]=operands;
 const operations: Record<string,(a:number,b:number)=>number>={add:(a,b)=>a+b,subtract:(a,b)=>a-b,multiply:(a,b)=>a*b,divide:(a,b)=>a/b};
 const fn=operations[operation]; if (!fn) throw new Error('Unsupported calculation');
 const result=rest.reduce(fn,first!); if (!Number.isFinite(result)) throw new Error('Non-finite result');
 return Math.round(result*1e8)/1e8;
}
