/**
 * AsrModelImport — 「我已有模型文件」点开后的二级面板：拖拽 / 选目录导入本地模型。
 *
 * 为什么做成拖拽而不是让用户填路径：
 *   填路径需要用户同时知道三件事——放哪、目录叫什么（那是一长串 sherpa 模型名）、
 *   文件名要不要对齐。拖拽只需要"把东西拖进来"。
 *   文件**叫什么名字都不影响**：服务端按内容指纹（大小 + sha256）认模型（见 server/asr-model-import.ts）。
 *
 * 为什么只传路径：Electron 能拿到拖入文件的**真实磁盘路径**，
 * 服务端直接读写那些路径 —— 几百 MB 的权重既不进内存、也不过网络。
 */

import React, { useState } from 'react';
import { hanaFetch } from '../../api';
import { t } from '../../helpers';
import { SettingsRow } from '../../components/SettingsRow';
import styles from '../../Settings.module.css';

interface ImportOutcome {
  placed: string[];
  incomplete: Array<{ id: string; missing: string[] }>;
  unrecognized: string[];
  errors: string[];
}

export function AsrModelImport({
  missingGroups = [],
  labelOf,
  onImported,
  onClose,
}: {
  /** 还缺什么，**按模型分组**（归属写清楚，否则用户会怀疑某个文件是多余的） */
  missingGroups?: Array<{ id: string; label: string; files: string[] }>;
  /** 把模型 id 变成给用户看的名字（由调用方提供，避免在这里再维护一份文案） */
  labelOf?: (id: string) => string;
  /** 导入结束（无论成功与否）时通知上层刷新模型状态 */
  onImported: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (id: string) => (labelOf ? labelOf(id) : id);

  const runImport = async (paths: string[]) => {
    if (!paths.length || busy) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await hanaFetch('/api/asr/models/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      const data = await res.json();
      if (data?.error) {
        setError(String(data.error));
        return;
      }
      setOutcome({
        placed: data?.placed || [],
        incomplete: data?.incomplete || [],
        unrecognized: data?.unrecognized || [],
        errors: data?.errors || [],
      });
      onImported();
    } catch (err: any) {
      setError(err?.message || t('settings.media.localModelImportFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const paths: string[] = [];
    for (const file of Array.from(event.dataTransfer?.files || [])) {
      // 用 Electron 给的真实路径；拿不到就只能走"选择文件夹"那条路
      const filePath = (window as any).platform?.getFilePath?.(file);
      if (filePath) paths.push(String(filePath));
    }
    void runImport(paths);
  };

  const pickFolder = async () => {
    const dir = await (window as any).hana?.selectFolder?.();
    if (dir) void runImport([String(dir)]);
  };

  return (
    // 用 SettingsRow 而不是自己写 div：行的内边距、右侧对齐都是现成的，
    // 手写一份迟早会与其它行对不上（用户已经指出过一次）。
    <SettingsRow
      divider={false}
      layout="stacked"
      label={t('settings.media.localModelDropTitle')}
      hint={t('settings.media.localModelDropHint')}
      control={
        <>
      {/* 虚线区就是"可以拖进来的地方"：把按钮放在里面，这块区域才有实体，不至于是个空框 */}
      <div
        className={`${styles.asrModelDropZone}${dragging ? ` ${styles.asrModelDropZoneActive}` : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className={styles.asrModelRowActions}>
          <button type="button" className={styles.asrModelDownloadButton} disabled={busy}
            onClick={() => void pickFolder()}>
            {busy ? t('settings.media.localModelImporting') : t('settings.media.localModelPickFolder')}
          </button>
          <button type="button" className={styles.asrModelDownloadButton} onClick={onClose}>
            {t('settings.media.localModelClose')}
          </button>
        </div>
      </div>

      {/* 结果一律说人话：成了什么、还缺什么、哪些认不出来 */}
      {missingGroups.length > 0 && (
        <div className={styles.asrModelHint}>
          {t('settings.media.localModelStillNeeded')}
          {missingGroups.map(group => (
            <div key={group.id}>{`${group.label}：${group.files.join('、')}`}</div>
          ))}
        </div>
      )}

      {error && <div className={styles.asrModelHint}>{error}</div>}
      {outcome && (
        <div className={styles.asrModelHint}>
          {outcome.placed.length > 0
            && `${t('settings.media.localModelImportPlaced')} ${outcome.placed.map(nameOf).join('、')}`}
          {outcome.incomplete.length > 0 && (
            <div>
              {outcome.incomplete.map(item => (
                <div key={item.id}>
                  {`${nameOf(item.id)} ${t('settings.media.localModelImportMissing')}${item.missing.join('、')}`}
                </div>
              ))}
            </div>
          )}
          {outcome.unrecognized.length > 0 && (
            <div>{`${t('settings.media.localModelImportUnknown')} ${outcome.unrecognized.join('、')}`}</div>
          )}
          {outcome.errors.map(msg => <div key={msg}>{msg}</div>)}
        </div>
      )}
        </>
      }
    />
  );
}
