import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import App from '../App';

/** node 环境下渲染（loadState 内部 try/catch，无 window 时回退内置示例）。 */
describe('App 冒烟', () => {
  it('默认示例渲染出四栏与事实校核面板', () => {
    const html = renderToString(<App />);
    // 四栏
    expect(html).toContain('共同底稿');
    expect(html).toContain('品牌版');
    expect(html).toContain('法务版');
    expect(html).toContain('合并结果');
    // 事实校核面板与默认示例中的事实冲突
    expect(html).toContain('事实完整性校核');
    expect(html).toContain('合计与分项不符');
    expect(html).toContain('比例超出范围');
    expect(html).toContain('引用待迁移');
    // 同步更新候选（合计 → 85万元）
    expect(html).toContain('同步更新候选');
    expect(html).toContain('85万元');
    // 顶栏区分文本冲突与事实冲突
    expect(html).toContain('文本冲突');
    expect(html).toContain('事实冲突');
  });
});
