import { collectCliFlagDescriptions } from './cli-flag-usage.mjs';
import { appendNativeResources, inspectNativeBinary, inspectNativeTextTail, parseBackendMetadata, prepareBackendMetadata, reserveBackendBudget } from './backend-metadata.mjs';
import { deriveBackendLayout } from './backend-layout.mjs';
import backendHook from './backend-hook.js';
import { CliCompatibilityError } from './cli-compatibility.mjs';
import { partitionCliDisplaySites } from './cli-code-space.mjs';
import { collectCliLocalizationPatches, applyCliLocalizationPatches, collectCliDisplayLabels } from './cli-localization.mjs';
import { collectCliStatusLocalizationPatches, applyCliStatusLocalizationPatches, collectCliUsageDisplayStrings, collectCliSummaryNounDisplayStrings } from './cli-status-localization.mjs';
import { collectCliDisplayStrings, applyCliDisplayStrings, collectCliSettingsDisplayStrings, applyCliContentDisplayStrings } from './cli-display.mjs';
import { collectNativeTitlePatch, applyNativeTitlePatch } from './native-title.mjs';
import { collectCliNoticeDisplayStrings, applyCliNoticeDisplayStrings } from './cli-notice-localization.mjs';
import { collectCliFeedbackDisplayStrings, collectCliUiLiterals, collectCliUnavailableMessageStrings } from './cli-ui-literals.mjs';
import { collectCliFooterActionDisplayStrings, collectCliNavigationLocalization } from './cli-navigation-localization.mjs';
import { collectCliModelFeatureDisplayStrings, collectCliModelEffortDisplayStrings, collectCliModelVariantDisplayStrings } from './cli-model-literals.mjs';
import { collectCliPluginDescriptionStrings } from './cli-panel-literals.mjs';
import { collectCliSubagentStatusDisplayStrings } from './cli-subagent-literals.mjs';
import { collectCliSwarmDescriptionStrings, collectCliSwarmStateDisplayStrings } from './cli-swarm-localization.mjs';
import { collectCliMainContextPatch, applyCliMainContextPatch } from './cli-context.mjs';
import { collectCliReleaseNotes } from './cli-release-notes.mjs';
import { collectCliPlanModeToolLabels } from './cli-tool-status-profiles.mjs';

const aligned = size => Math.ceil(size / 16) * 16;
const lookupFeatures = [
  ['设置标签', collectCliDisplayLabels, applyCliDisplayStrings],
  ['参数用法', collectCliFlagDescriptions, applyCliContentDisplayStrings],
  ['通用显示', collectCliDisplayStrings, applyCliDisplayStrings],
  ['设置选项', collectCliSettingsDisplayStrings, applyCliContentDisplayStrings],
  ['额度显示', collectCliUsageDisplayStrings, applyCliContentDisplayStrings],
  ['工具摘要', collectCliSummaryNounDisplayStrings, applyCliDisplayStrings],
  ['规划模式工具标签', collectCliPlanModeToolLabels, applyCliContentDisplayStrings],
  ['系统公告', collectCliNoticeDisplayStrings, applyCliNoticeDisplayStrings],
  ['更新说明', collectCliReleaseNotes, applyCliContentDisplayStrings],
  ['模型思考档位', collectCliModelEffortDisplayStrings, applyCliContentDisplayStrings],
  ['编排器模型', collectCliModelVariantDisplayStrings, applyCliDisplayStrings],
  ['模型能力', collectCliModelFeatureDisplayStrings, applyCliContentDisplayStrings],
  ['反馈选项', collectCliFeedbackDisplayStrings, applyCliContentDisplayStrings],
  ['底部导航', collectCliFooterActionDisplayStrings, applyCliContentDisplayStrings],
  ['插件说明', collectCliPluginDescriptionStrings, applyCliContentDisplayStrings],
  ['子代理状态', collectCliSubagentStatusDisplayStrings, applyCliContentDisplayStrings],
  ['协作群状态', collectCliSwarmStateDisplayStrings, applyCliContentDisplayStrings],
  ['协作群命令说明', collectCliSwarmDescriptionStrings, applyCliContentDisplayStrings],
  ['命令提示', collectCliUnavailableMessageStrings, applyCliContentDisplayStrings],
];

/** Collection and diagnostics use the same native sites, dictionary and reachability rules. */
export function collectCliBuildPlan(original, dictionary, {contextOverridesEnabled = false} = {}) {
  const metadata = inspectNativeBinary(original), tail = inspectNativeTextTail(original);
  // The existing budget slot starts with 32 bytes of state and at least one instruction.
  // In development builds the native emitter determines the exact size for this Go layout.
  const codeBytes = contextOverridesEnabled ? backendHook.emitStubs({base:metadata.imageBase,
    code:metadata.imageBase + tail.codeRva, data:metadata.imageBase, capacity:tail.capacity,
    layout:deriveBackendLayout(original, parseBackendMetadata(original))}).code.length : 4;
  const budgetSize = aligned(tail.codeRva - tail.rva + codeBytes), capacity = tail.size - budgetSize;
  if (capacity < 16 || capacity % 16 !== 0) throw new CliCompatibilityError('当前 CLI 缺少可用的显示代码空间');
  const codeSpace = {codeAddress:metadata.imageBase + tail.rva + budgetSize, capacity};
  const unsupported = [], missing = [];
  function collect(feature, collector, ...options) {
    try {
      const plan = collector(original, dictionary, metadata, ...options);
      if (plan.unsupported?.length) unsupported.push({feature, details:plan.unsupported});
      if (plan.missing) missing.push(...plan.missing);
      return plan;
    } catch (error) {
      if (!(error instanceof CliCompatibilityError)) throw error;
      unsupported.push({feature, details:[error.message]});
      return null;
    }
  }
  function reachable(feature, collected) {
    if (!collected) return null;
    const {plan, skippedSites} = partitionCliDisplaySites(collected, codeSpace);
    if (skippedSites.length) unsupported.push({feature, details:skippedSites.map(site =>
      `显示位置超出范围（${site.role ?? site.functionName ?? 'RVA'} +0x${site.rva.toString(16)}）`)});
    if (collected.requireAllSites && skippedSites.length) return null;
    return plan.sites.length ? plan : null;
  }
  const base = collect('命令和设置说明', collectCliLocalizationPatches) ?? {patches:[], missing:[]};
  const status = collect('状态和提示', collectCliStatusLocalizationPatches, {codeSpace}) ??
    {imageBase:metadata.imageBase, patches:[], missing:[]};
  const literals = collect('界面固定文案', collectCliUiLiterals, status.patches);
  if (literals) status.patches.push(...literals.patches);
  const navigation = collect('界面导航', collectCliNavigationLocalization, status.patches);
  if (navigation) status.patches.push(...navigation.patches);
  const title = collect('会话标题', () => collectNativeTitlePatch(original, metadata));
  const lookups = [];
  for (const [feature, collector, apply] of lookupFeatures) {
    const plan = reachable(feature, collect(feature, collector));
    if (plan?.entries.length) lookups.push({feature, plan, apply});
  }
  const originals = new Set();
  for (const entry of [...base.patches, ...status.patches]) originals.add(entry.original);
  let references = base.patches.length + status.patches.length;
  for (const {plan} of lookups) {
    references += plan.entries.length;
    for (const entry of plan.entries) originals.add(entry.original);
  }
  const report = {translated:originals.size, references, missing, unsupported};
  return {metadata, codeSpace, base, status, title, lookups, report};
}

export function buildLocalizedCli(original, translations, {mainTokens, contextOverridesEnabled}) {
  const {metadata, codeSpace, base, status, title, lookups, report} = collectCliBuildPlan(original, translations, {contextOverridesEnabled});
  if (!base.patches.length && !status.patches.length && !lookups.some(lookup => lookup.feature === '设置标签')) {
    throw new CliCompatibilityError('当前版本的核心界面文案未匹配');
  }
  const main = collectCliMainContextPatch(original, metadata, mainTokens, {contextOverridesEnabled});
  const strings = new Map(), chunks = [];
  let size = 0;
  function add(value) {
    if (strings.has(value)) return;
    strings.set(value, size);
    const bytes = Buffer.from(value + '\0');
    chunks.push(bytes);
    size += bytes.length;
  }
  for (const entry of [...base.patches, ...status.patches]) add(entry.translated);
  for (const {plan} of lookups) {
    for (const entry of plan.entries) {
      if (plan.matchContent) add(entry.original);
      add(entry.translated);
    }
  }
  if (title) add(title.value);
  if (main) add(main.value);
  let resourceSize = aligned(size);
  for (const lookup of lookups) {
    lookup.tableOffset = resourceSize;
    resourceSize += lookup.plan.entries.length * 16;
  }
  const resources = appendNativeResources(original, Buffer.concat([...chunks, Buffer.alloc(resourceSize - size)]), {reserveBudgetHeader:true});
  const {binary} = resources;
  const addressOf = bytes => resources.address + strings.get(bytes.toString('utf8'));
  applyCliLocalizationPatches(binary, base, addressOf);
  if (title) applyNativeTitlePatch(binary, title, resources.address + strings.get(title.value));
  if (main) applyCliMainContextPatch(binary, main, resources.address + strings.get(main.value));
  const slot = reserveBackendBudget(binary, {trailingBytes:codeSpace.capacity});
  const codeStart = slot.rva + slot.size;
  if (metadata.imageBase + codeStart !== codeSpace.codeAddress) throw new Error('CLI 显示代码区与准备的位置不符');
  let offset = 0;
  function placement() {
    return {codeAddress:codeSpace.codeAddress + offset, codeFileOffset:codeStart + offset, capacity:codeSpace.capacity - offset, allocateString:addressOf};
  }
  offset += aligned(applyCliStatusLocalizationPatches(binary, status, addressOf, placement()).codeBytes);
  for (const lookup of lookups) {
    const rendered = lookup.apply(binary, lookup.plan, {...placement(), tableAddress:resources.address + lookup.tableOffset});
    rendered.table.copy(binary, resources.fileOffset + lookup.tableOffset);
    offset += aligned(rendered.codeSize);
  }
  const layout = contextOverridesEnabled ? deriveBackendLayout(binary, prepareBackendMetadata(binary)) : null;
  return {binary, layout, localization:{...report, missing:report.missing.length}};
}
