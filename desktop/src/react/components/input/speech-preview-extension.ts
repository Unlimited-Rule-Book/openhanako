/**
 * speech-preview-extension.ts — 语音输入的「预览层」
 *
 * 为什么用 decoration 而不是直接往文档里写字：
 *  语音识别会不断吐出新的（而且可能被改写的）partial 文本。如果每来一次就改文档：
 *    · 撤销历史被冲爆（按一次 Ctrl+Z 只能退回一个字）
 *    · 草稿保存被反复触发
 *    · 选区/光标被抢
 *  用 decoration 就完全不碰文档：预览是"画上去的"，不是内容。等真的定稿了
 *  （句末或用户按停止）再一次性插入文档 —— 那时才产生一个可撤销的步骤。
 *
 * 这个文件同时是「引擎差异的适配口」：引擎会不会回溯改写已输出的字，前端不用关心，
 * 反正每次都是整段替换预览。
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SpeechPreviewState {
  /** 预览插在文档的哪个位置；null 表示没有预览 */
  pos: number | null;
  /** 当前这一句到目前为止的完整文本（整段替换，不要拼接） */
  text: string;
}

const EMPTY: SpeechPreviewState = { pos: null, text: '' };

export const speechPreviewKey = new PluginKey<SpeechPreviewState>('speechPreview');

export const SpeechPreviewExtension = Extension.create({
  name: 'speechPreview',

  addProseMirrorPlugins() {
    return [
      new Plugin<SpeechPreviewState>({
        key: speechPreviewKey,
        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(speechPreviewKey) as Partial<SpeechPreviewState> | undefined;
            // 先把上一轮记下的位置平移到新坐标系 —— 用户边听写边打字时，
            // 预览位置和"最终往哪插"必须跟着一起动，两者一旦各算一套就会错位。
            const mappedPos = value.pos === null ? null : tr.mapping.map(value.pos);
            if (!meta) return value.pos === null ? value : { ...value, pos: mappedPos };
            // meta 语义：
            //   · 带 pos  —— "从这一处开始"（一轮语音的起点、或者提交后挪到新位置）
            //   · 只带 text —— 只换预览文字，**位置沿用已平移的那个**
            //     （以前的写法是把调用方手里那个旧数字直接写回来，等于每来一个 partial
            //      就把平移结果覆盖掉，于是用户一边打字、预览一边错位）
            if (meta.pos === undefined && meta.text === '') return EMPTY;
            return {
              pos: meta.pos !== undefined ? meta.pos : mappedPos,
              text: meta.text !== undefined ? meta.text : value.text,
            };
          },
        },
        props: {
          decorations(state) {
            const value = speechPreviewKey.getState(state);
            if (!value || value.pos === null || !value.text) return null;
            const widget = Decoration.widget(
              value.pos,
              () => {
                const span = document.createElement('span');
                span.className = 'speech-preview';
                span.textContent = value.text;
                return span;
              },
              { side: 1 },
            );
            return DecorationSet.create(state.doc, [widget]);
          },
        },
      }),
    ];
  },
});

/**
 * 更新预览。**只改插件状态，不改文档** —— 所以不产生撤销步骤，
 * 也不会触发 editor 的 update（草稿保存不受影响）。
 */
export function setSpeechPreview(
  editor: { view?: { dispatch?: (tr: any) => void }; state?: any } | null | undefined,
  // 可以只给 text（只换内容、位置沿用已平移的）或只给 pos（从这里开始）—— 见 apply 的说明
  state: Partial<SpeechPreviewState>,
) {
  const view = editor?.view;
  const editorState = editor?.state;
  if (!view?.dispatch || !editorState) return;
  view.dispatch(editorState.tr.setMeta(speechPreviewKey, state));
}

/** 清掉预览 */
export function clearSpeechPreview(editor: any) {
  setSpeechPreview(editor, EMPTY);
}
