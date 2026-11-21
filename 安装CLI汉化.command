#!/bin/zsh
set -euo pipefail
umask 077

source_dir="${0:A:h}"
runtime_dir="$HOME/Library/Application Support/AntigravityChineseHelper/cli/application/runtime"
bin_dir="$HOME/.local/bin"
launcher="$bin_dir/agy-zh"
marker='# AntigravityChineseHelper CLI launcher'

for entry in agy-zh agyzh agyz; do
    path_to_check="$bin_dir/$entry"
    if [[ -e "$path_to_check" || -L "$path_to_check" ]]; then
        if ! /usr/bin/grep -Fqx "$marker" "$path_to_check" 2>/dev/null; then
            echo "CLI 入口已被现有文件占用：$path_to_check" >&2
            exit 1
        fi
    fi
done

runtime_files=(
    "$source_dir"/runtime/cli*.mjs(:t)
    context-policy.mjs
    native-copy.mjs native-title.mjs native-strings.mjs backend-metadata.mjs backend-layout.mjs
    backend-runtime.mjs backend-hook.js backend-mach.c cli-launch.c
    translations.json cli-release-notes.zh-CN.json
)
for file in "${runtime_files[@]}"; do
    if [[ ! -f "$source_dir/runtime/$file" ]]; then
        echo "缺少 CLI 运行文件：$source_dir/runtime/$file" >&2
        exit 1
    fi
done

mkdir -p "$runtime_dir" "$bin_dir"
for file in "${runtime_files[@]}"; do
    /bin/cp "$source_dir/runtime/$file" "$runtime_dir/$file"
done
# The launcher includes cli-*.mjs files in its build-cache inputs.
/bin/rm -f "$runtime_dir/cli-title-localization.mjs"

temporary_launcher=$(/usr/bin/mktemp "$bin_dir/.agy-zh.XXXXXX")
trap '/bin/rm -f "$temporary_launcher"' EXIT
cat > "$temporary_launcher" <<'LAUNCHER'
#!/bin/zsh
# AntigravityChineseHelper CLI launcher
set -euo pipefail

runtime_dir="$HOME/Library/Application Support/AntigravityChineseHelper/cli/application/runtime"
candidates=()
if [[ -n "${ANTIGRAVITY_HELPER_NODE:-}" ]]; then
    candidates+=("$ANTIGRAVITY_HELPER_NODE")
fi
path_node=$(command -v node 2>/dev/null || true)
if [[ -n "$path_node" ]]; then
    candidates+=("$path_node")
fi
candidates+=("$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node)

for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" && -f "$candidate" ]] && "$candidate" --experimental-sqlite --disable-warning=ExperimentalWarning -e \
        'const major=Number(process.versions.node.split(".")[0]);if(!Number.isInteger(major)||major<22)process.exit(1);require("node:sqlite")' \
        >/dev/null 2>&1; then
        exec "$candidate" "$runtime_dir/cli.mjs" "$@"
    fi
done

echo '未找到支持内置 SQLite 的 Node.js 22 或更新版本。请安装 Node.js，或用 ANTIGRAVITY_HELPER_NODE 指定路径。' >&2
exit 1
LAUNCHER
/bin/chmod 755 "$temporary_launcher"
"$temporary_launcher" --help
/bin/mv -f "$temporary_launcher" "$launcher"
for entry in agyzh agyz; do
    /bin/ln -sfn agy-zh "$bin_dir/$entry"
done

echo "已安装 CLI 入口：$launcher"
echo '也可使用：agyzh、agyz'
echo '启动中文 CLI：agy-zh'
