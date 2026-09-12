lines = open('app.py', encoding='utf-8').read().replace('\r\n', '\n').split('\n')
idx = None
for i, l in enumerate(lines):
    if l.strip() == 'context += (f"':
        idx = i
        break
assert idx is not None, 'not found'
# 后续 3 行应是：空行、" if context else...、{blk}"
assert lines[idx+1].strip() == '', repr(lines[idx+1])
assert '" if context else' in lines[idx+2], repr(lines[idx+2])
assert lines[idx+3].strip() == '{blk}"', repr(lines[idx+3])
lines[idx] = '                    context += (f"\n\n" if context else "") + f"【{s} 快照（问题提及品种，与当前选中对比分析用）】\n{blk}"'
del lines[idx+1:idx+4]
open('app.py', 'w', encoding='utf-8', newline='').write('\n'.join(lines))
# 立即回读验证
chk = open('app.py', encoding='utf-8').read()
assert '快照（问题提及品种' in chk and '\n{blk}"' in chk
print('写入并验证成功')
