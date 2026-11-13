// Isolated executable for the transport's actual four-entry publication checks.
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mach-o/dyld.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((naked, noinline, aligned(16384))) int site0(void) { __asm__("mov w0,#7\nret\nnop\nnop"); }
__attribute__((naked, noinline, aligned(16384))) int site1(void) { __asm__("mov w0,#8\nret\nnop\nnop"); }
__attribute__((naked, noinline, aligned(16384))) int site2(void) { __asm__("mov w0,#9\nret\nnop\nnop"); }
__attribute__((naked, noinline, aligned(16384))) int site3(void) { __asm__("mov w0,#10\nret\nnop\nnop"); }
static _Atomic unsigned long calls = 0, errors = 0;
static _Atomic int running = 1;
static uintptr_t budget_code;
static int (*volatile functions[4])(void) = {site0, site1, site2, site3};
static void *worker(void *unused) {
    (void) unused;
    while (atomic_load(&running)) {
        for (int i = 0; i < 4; i++) { int result = functions[i](); if (result != 7 + i && result != 42) atomic_fetch_add(&errors, 1); }
        atomic_fetch_add(&calls, 1);
    }
    return NULL;
}
static vm_prot_t protection(uintptr_t pointer) {
    mach_vm_address_t address = pointer; mach_vm_size_t size; vm_region_basic_info_data_64_t info;
    mach_msg_type_number_t count = VM_REGION_BASIC_INFO_COUNT_64; mach_port_t object = MACH_PORT_NULL;
    if (mach_vm_region(mach_task_self(), &address, &size, VM_REGION_BASIC_INFO_64, (vm_region_info_t)&info, &count, &object)) exit(2);
    if (object) mach_port_deallocate(mach_task_self(), object);
    return info.protection;
}
static void report(void) {
    printf("{\"pid\":%d,\"base\":\"0x%llx\",\"calls\":%lu,\"errors\":%lu,\"values\":[%d,%d,%d,%d],\"sites\":[",
        getpid(), (unsigned long long)(uintptr_t)_dyld_get_image_header(0), atomic_load(&calls), atomic_load(&errors), functions[0](), functions[1](), functions[2](), functions[3]());
    for (int i = 0; i < 4; i++) {
        uint64_t site = (uint64_t)(uintptr_t)functions[i];
        uint32_t *words = (uint32_t*)(uintptr_t)site;
        printf("%s{\"address\":\"0x%llx\",\"protection\":%d,\"words\":[%u,%u,%u,%u]}", i ? "," : "", (unsigned long long)site, protection(site), words[0], words[1], words[2], words[3]);
    }
    printf("],\"code\":{\"protection\":%d,\"hex\":\"", protection(budget_code));
    for (int i = 0; i < 32; i++) printf("%02x", ((uint8_t*)budget_code)[i]);
    puts("\"}}");
}
// Keep the parser-owned tail slot on a fifth text page, so a killed first
// publication can expose the slot without connecting any of the four sites.
__attribute__((naked, noinline, aligned(16384), used)) static void tail_anchor(void) { __asm__("ret"); }
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    budget_code = (uintptr_t)_dyld_get_image_header(0) + strtoull(argv[1], NULL, 0);
    setvbuf(stdout, NULL, _IONBF, 0); pthread_t threads[8];
    for (int i = 0; i < 8; i++) if (pthread_create(&threads[i], NULL, worker, NULL)) return 2;
    report(); char command[64];
    while (fgets(command, sizeof(command), stdin)) { if (command[0] == 'q') break; if (command[0] == 's') report(); }
    atomic_store(&running, 0); for (int i = 0; i < 8; i++) pthread_join(threads[i], NULL);
    return atomic_load(&errors) ? 1 : 0;
}
