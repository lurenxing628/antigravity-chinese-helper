/* Frida installer support. Native mappings outlive scripts and in-flight stubs. */
'use strict';

globalThis.BackendCodeMemory = (() => {
  function create({ codeSize, dataSize }) {
    if (Process.platform !== 'darwin' || Process.arch !== 'arm64') {
      throw new Error('Native backend memory requires macOS arm64');
    }

    const pageSize = Process.pageSize;
    const pages = size => {
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid native mapping size');
      return Math.ceil(size / pageSize) * pageSize;
    };
    const codeCapacity = pages(codeSize);
    const dataCapacity = pages(dataSize);
    const mmap = new NativeFunction(Module.getGlobalExportByName('mmap'), 'pointer',
      ['pointer', 'ulong', 'int', 'int', 'int', 'int64']);
    const allocate = size => {
      const address = mmap(ptr(0), size, 3, 0x1002, -1, 0); // RW, MAP_PRIVATE | MAP_ANON
      if (address.equals(ptr(-1))) throw new Error('Could not allocate native backend memory');
      return address;
    };

    const code = allocate(codeCapacity);
    const data = allocate(dataCapacity);
    const patches = [];
    let sealed = false;

    return {
      code,
      data,
      sealCode() {
        if (sealed) return;
        if (!Memory.protect(code, codeCapacity, 'r-x')) throw new Error('Could not seal native backend code');
        sealed = true;
      },
      replaceFast(site, stub) {
        if (!sealed) throw new Error('Native backend code must be sealed before activation');
        if (stub.compare(code) < 0 || stub.compare(code.add(codeCapacity)) >= 0) {
          throw new Error('Replacement is outside native backend code');
        }
        Interceptor.replaceFast(site, stub);
        // Record before flushing: if a later installation or flush fails,
        // revert() must still recover every replacement already accepted.
        patches.push(site);
        Interceptor.flush();
      },
      revert() {
        let failure;
        for (let index = patches.length - 1; index >= 0; index--) {
          try {
            Interceptor.revert(patches[index]);
            Interceptor.flush();
            patches.splice(index, 1);
          } catch (error) {
            failure ??= error;
          }
        }
        // Do not munmap code or data. A thread may already have entered a
        // stackless stub; its own continuation stays valid until process exit.
        if (failure) throw failure;
      },
    };
  }

  return { create };
})();
