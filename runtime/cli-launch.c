// Keep the CLI in its terminal process group, but hold its first instruction
// until the controller has installed the native context budget.
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child_pid;
static volatile sig_atomic_t shutdown_signal;

static void receive_signal(int signal_number) {
    // The terminal sends SIGINT to our whole foreground group. The CLI owns
    // its Ctrl+C behavior; forwarding it would deliver that key twice.
    if (signal_number == SIGINT) return;
    shutdown_signal = signal_number;
    if (child_pid > 0) kill((pid_t) child_pid, signal_number);
}

static int wait_child(pid_t pid) {
    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno == EINTR) continue;
        perror("Wait for CLI");
        return 125;
    }
    child_pid = 0;
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 125;
}

static int cancel_child(pid_t pid, const char *message) {
    kill(pid, SIGKILL);
    wait_child(pid);
    if (message) fprintf(stderr, "%s\n", message);
    return shutdown_signal ? 128 + shutdown_signal : 125;
}

static int report_child(pid_t pid) {
    char message[64];
    int length = snprintf(message, sizeof(message), "{\"pid\":%ld}\n", (long) pid);
    size_t sent = 0;
    while (sent < (size_t) length && !shutdown_signal) {
        ssize_t count = write(3, message + sent, (size_t) length - sent);
        if (count > 0) sent += (size_t) count;
        else if (count < 0 && errno == EINTR) continue;
        else return -1;
    }
    return sent == (size_t) length ? 0 : -1;
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') {
        fprintf(stderr, "Usage: cli-launch ABSOLUTE_CLI_PATH [ARG ...] (PID on fd 3; release R on fd 4)\n");
        return 125;
    }

    struct sigaction action = {0};
    action.sa_handler = receive_signal;
    sigemptyset(&action.sa_mask);
    for (size_t index = 0; index < 3; index++) {
        const int signals[] = {SIGINT, SIGTERM, SIGHUP};
        if (sigaction(signals[index], &action, NULL) < 0) {
            perror("Install CLI launcher signal handler");
            return 125;
        }
    }
    // A controller that closes the PID pipe must cancel its stopped child.
    signal(SIGPIPE, SIG_IGN);

    sigset_t blocked, previous_mask, child_defaults;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGHUP);
    if (sigprocmask(SIG_BLOCK, &blocked, &previous_mask) < 0) {
        perror("Block CLI launcher signals");
        return 125;
    }
    sigemptyset(&child_defaults);
    const int defaults[] = {SIGINT, SIGQUIT, SIGTERM, SIGHUP, SIGPIPE, SIGTSTP, SIGTTIN, SIGTTOU};
    for (size_t index = 0; index < sizeof(defaults) / sizeof(defaults[0]); index++) sigaddset(&child_defaults, defaults[index]);

    posix_spawnattr_t attributes;
    posix_spawn_file_actions_t actions;
    int error = posix_spawnattr_init(&attributes);
    if (!error) error = posix_spawn_file_actions_init(&actions);
    if (error) {
        fprintf(stderr, "Prepare CLI launch: %s\n", strerror(error));
        return 125;
    }
    error = posix_spawnattr_setflags(&attributes,
        POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    if (!error) error = posix_spawnattr_setsigmask(&attributes, &previous_mask);
    if (!error) error = posix_spawnattr_setsigdefault(&attributes, &child_defaults);
    if (!error) error = posix_spawn_file_actions_addclose(&actions, 3);
    if (!error) error = posix_spawn_file_actions_addclose(&actions, 4);
    pid_t pid = 0;
    if (!error) error = posix_spawn(&pid, argv[1], &actions, &attributes, argv + 1, environ);
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    if (error) {
        fprintf(stderr, "Start CLI: %s\n", strerror(error));
        return 125;
    }
    child_pid = pid;
    sigprocmask(SIG_SETMASK, &previous_mask, NULL);

    if (report_child(pid) < 0) return cancel_child(pid, "CLI controller closed before receiving the process ID");
    close(3);
    char release = 0;
    ssize_t count = -1;
    while (!shutdown_signal) {
        count = read(4, &release, 1);
        if (count < 0 && errno == EINTR) continue;
        break;
    }
    close(4);
    if (shutdown_signal) return cancel_child(pid, NULL);
    if (count != 1 || release != 'R') return cancel_child(pid, "CLI launch gate closed before context setup completed");
    if (kill(pid, SIGCONT) < 0) return cancel_child(pid, "Cannot release CLI launch gate");
    return wait_child(pid);
}
