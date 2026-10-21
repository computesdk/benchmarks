import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { printData } from '../output.js';

describe('printData', () => {
  let logSpy: MockInstance<Parameters<typeof console.log>, void>;
  let tableSpy: MockInstance<Parameters<typeof console.table>, void>;
  let dirSpy: MockInstance<Parameters<typeof console.dir>, void>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    tableSpy = vi.spyOn(console, 'table').mockImplementation(() => {});
    dirSpy = vi.spyOn(console, 'dir').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints JSON when json option is set', () => {
    printData([{ a: 1 }], { json: true });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify([{ a: 1 }], null, 2));
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints JSON when format is json', () => {
    printData({ a: 1 }, { format: 'json' });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints "No results." for null', () => {
    printData(null);
    expect(logSpy).toHaveBeenCalledWith('No results.');
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints "No results." for undefined', () => {
    printData(undefined);
    expect(logSpy).toHaveBeenCalledWith('No results.');
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints "No results." for an empty array', () => {
    printData([]);
    expect(logSpy).toHaveBeenCalledWith('No results.');
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints a non-empty array as a table by default', () => {
    printData([{ a: 1 }]);
    expect(tableSpy).toHaveBeenCalledWith([{ a: 1 }]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints a non-empty array with dir when format is not table or json', () => {
    printData([{ a: 1 }], { format: undefined });
    expect(tableSpy).toHaveBeenCalledWith([{ a: 1 }]);
  });

  it('prints an object as a table by default', () => {
    printData({ a: 1, b: 2 });
    expect(tableSpy).toHaveBeenCalledWith({ a: 1, b: 2 });
    expect(logSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints "No results." for an empty object', () => {
    printData({});
    expect(logSpy).toHaveBeenCalledWith('No results.');
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });

  it('prints a primitive with console.log', () => {
    printData('hello');
    expect(logSpy).toHaveBeenCalledWith('hello');
    expect(tableSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
  });
});
