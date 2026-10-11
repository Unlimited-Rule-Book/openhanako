import React from 'react';
import styles from './settings-components.module.css';

type HintVariant = 'default' | 'warn';
type Layout = 'inline' | 'stacked' | 'inline-hint';
interface SettingsRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  hint?: React.ReactNode;
  hintVariant?: HintVariant;
  control: React.ReactNode;
  layout?: Layout;
  /**
   * 是否在这一行上方画分隔线（默认画）。
   *
   * 用于"同一个设置项被拆成两行"的情况：例如「语音输入」下面的「识别方式」+「识别引擎」
   * 其实是同一件事，行与行之间不该有分隔线，否则看起来像两个互不相干的设置。
   * 显式给 prop 比靠相邻选择器猜更清楚，也不会被后面的行结构变化带偏。
   */
  divider?: boolean;
  className?: string;
}

export function SettingsRow({
  label,
  hint,
  hintVariant = 'default',
  control,
  layout = 'inline',
  divider = true,
  className,
  ...rootProps
}: SettingsRowProps) {
  const rootClass = [
    styles.row,
    layout === 'inline'
      ? styles.rowInline
      : layout === 'stacked'
        ? styles.rowStacked
        : styles.rowInlineHint,
    !divider && styles.rowNoDivider,
    className,
  ].filter(Boolean).join(' ');

  const hintClass = [
    styles.rowHint,
    hintVariant === 'warn' && styles.rowHintWarn,
  ].filter(Boolean).join(' ');

  // inline-hint：label 与 control 同一行（control 靠右），hint 整行铺在下面
  if (layout === 'inline-hint') {
    return (
      <div {...rootProps} className={rootClass}>
        <div className={styles.rowHead}>
          <div className={styles.rowLabel}>{label}</div>
          <div className={styles.rowControl}>{control}</div>
        </div>
        {hint && <div className={hintClass}>{hint}</div>}
      </div>
    );
  }

  return (
    <div {...rootProps} className={rootClass}>
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{label}</div>
        {hint && <div className={hintClass}>{hint}</div>}
      </div>
      <div className={styles.rowControl}>{control}</div>
    </div>
  );
}
