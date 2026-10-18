#!/usr/bin/env python3
# 把 Gemini 生成的原圖（generated-images/，2048×2048 的 JPEG，不放進 git）做成遊戲用的貼圖（tex/*.webp）
# 用法：python3 tools/make-photo-tex.py            → 全部重做
#       python3 tools/make-photo-tex.py --preview  → 另外在 playtest-out/photo-tex-preview.jpg 拼一張 2×2 重複排的預覽（看接縫）
# 每張貼圖都要能重複排不露出接縫：
# - 規則花紋（壁紙、地毯、地磚、人字拼）：先找出花紋重複的間距，剛好裁幾個整數間距，左右上下才接得起來
# - 不規則的（絨布、水泥、鐵板）：把圖平移一半再跟原圖混合，接縫藏在中間
# 車廂的牆是一張合成圖：上面壁紙、中間黃銅線、下面胡桃木鑲板和踢腳板（跟 render3d.js 原本畫的 walnutTex 一樣的排法）
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'generated-images')
OUT = os.path.join(ROOT, 'tex')
# 貼圖名稱 → 原圖檔名（Gemini 下載下來的名字）
SOURCES = {
    'wallpaper': 'Gemini_Generated_Image_k7v0u2k7v0u2k7v0.jpeg',
    'walnut': 'Gemini_Generated_Image_ui4wi3ui4wi3ui4w.jpeg',
    'velvet': 'Gemini_Generated_Image_kcmz3rkcmz3rkcmz.jpeg',
    'runner': 'Gemini_Generated_Image_r8kjebr8kjebr8kj.jpeg',
    'lounge': 'Gemini_Generated_Image_osfaw5osfaw5osfa.jpeg',
    'tile': 'Gemini_Generated_Image_g7xurtg7xurtg7xu.jpeg',
    'ceiling': 'Gemini_Generated_Image_ag6ex2ag6ex2ag6e.jpeg',
    'iron': 'Gemini_Generated_Image_k2suq3k2suq3k2su.jpeg',
    'herringbone': 'Gemini_Generated_Image_w74rb7w74rb7w74r.jpeg',
    'concrete': 'Gemini_Generated_Image_lq8fk7lq8fk7lq8f.jpeg',
}


def load(name):
    return np.asarray(Image.open(os.path.join(SRC, SOURCES[name])).convert('RGB'), dtype=np.float32)


def period(a, axis, lo=0.06, hi=0.6):
    """花紋沿著某個方向重複的間距（像素）：自相關裡第一個夠高的峰（夠高＝至少是範圍內最高峰的八成）"""
    g = a.mean(axis=2)
    g = g - g.mean()
    f = np.fft.rfft2(g)
    ac = np.fft.irfft2(f * np.conj(f), s=g.shape)
    line = ac[0, :] if axis == 1 else ac[:, 0]
    n = len(line)
    a0, a1 = int(n * lo), int(n * hi)
    top = line[a0:a1].max()
    k = next(k for k in range(a0, a1) if line[k] >= line[k - 1] and line[k] >= line[k + 1] and line[k] >= 0.8 * top)
    # 拋物線內插，間距可以是小數
    y0, y1, y2 = line[k - 1], line[k], line[k + 1]
    d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if (y0 - 2 * y1 + y2) != 0 else 0
    return k + d


def crop_periods(a, px, py):
    """裁成剛好整數個間距（盡量大），左右、上下就接得起來"""
    h, w = a.shape[:2]
    nx, ny = max(1, int(w // px)), max(1, int(h // py))
    cw, ch = int(round(nx * px)), int(round(ny * py))
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    return a[y0:y0 + ch, x0:x0 + cw], nx, ny


def blend_axis(a, axis, frac):
    """沿著一個方向做成可以重複：邊緣換成平移一半的圖（它的邊緣是原圖的中間，接得起來），接縫藏在中間"""
    n = a.shape[axis]
    r = np.roll(a, n // 2, axis=axis)
    t = np.arange(n) / (n - 1)
    d = np.minimum(t, 1 - t)                     # 離邊緣多遠（0～0.5）
    m = np.clip(d / frac, 0, 1)
    m = m * m * (3 - 2 * m)                      # 平滑
    shape = [1, 1, 1]; shape[axis] = n
    m = m.reshape(shape)
    return a * m + r * (1 - m)


def tileable(a, frac=0.22, axes=(0, 1)):
    for ax in axes:
        a = blend_axis(a, ax, frac)
    return a


def to_img(a, size):
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).resize(size, Image.LANCZOS)


def save(img, name, q=80):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + '.webp')
    img.save(p, 'WEBP', quality=q, method=6)
    print(f'{name}.webp {img.size[0]}×{img.size[1]} {os.path.getsize(p) // 1024} KB')
    return img


def periodic(name, size=512, frac=0.08, lo=0.06, hi=0.6):
    a = load(name)
    px, py = period(a, 1, lo, hi), period(a, 0, lo, hi)
    a, nx, ny = crop_periods(a, px, py)
    print(f'  {name}：間距 {px:.1f}×{py:.1f}，裁成 {nx}×{ny} 個')
    return to_img(tileable(a, frac), (size, size))


def wall():
    # 車廂的牆（512×1024，貼在 1 公尺寬、2.7 公尺高的牆上，所以縱向的像素比較「長」：要先把圖壓扁 0.74 倍才不會變形）
    W, H, k = 512, 1024, 1024 / 2.7 / 512
    img = Image.new('RGB', (W, H))
    # 壁紙：左右要接得起來（每一格牆都是一整張），寬度剛好裁 7 個花紋；上下不重複，一整段用同一張圖
    wp = load('wallpaper')
    px = period(wp, 1)
    wp_c = wp[:, :int(round(7 * px))]
    wp_c = tileable(wp_c, 0.04, axes=(1,))
    top0, top1 = 30, 588                          # 壁紙的範圍（上面 30 像素是線板）
    img.paste(to_img(wp_c, (W, top1 - top0)), (0, top0))
    d = ImageDraw.Draw(img)
    # 天花板下面的線板
    for y in range(0, top0):
        t = y / top0
        c = int(178 + 30 * np.sin(t * np.pi * 2.2))
        d.line([(0, y), (W, y)], fill=(c, int(c * 0.93), int(c * 0.78)))
    d.rectangle([0, top0 - 3, W, top0], fill=(70, 58, 40))
    # 黃銅線：發黑、長銅綠
    b0, b1 = 588, 620
    for y in range(b0, b1):
        t = (y - b0) / (b1 - b0)
        v = 0.35 + 0.65 * np.sin(t * np.pi) ** 0.6
        d.line([(0, y), (W, y)], fill=(int(201 * v), int(162 * v), int(74 * v)))
    # 淡淡的銅綠和發黑的地方
    ov = Image.new('RGBA', (W, b1 - b0), (0, 0, 0, 0)); od = ImageDraw.Draw(ov)
    rng = np.random.default_rng(3)
    for _ in range(40):
        x, y, r = rng.uniform(0, W), rng.uniform(4, b1 - b0 - 4), rng.uniform(3, 14)
        od.ellipse([x - r, y - r * 0.4, x + r, y + r * 0.4], fill=(60, 105, 80, 50) if rng.random() < 0.6 else (20, 14, 6, 70))
    img.paste(ov.filter(ImageFilter.GaussianBlur(2)), (0, b0), ov.filter(ImageFilter.GaussianBlur(2)))
    # 胡桃木鑲板：左右接得起來
    wn = tileable(load('walnut'), 0.06, axes=(1,))
    p0, p1 = 620, 976
    img.paste(to_img(wn, (W, p1 - p0)), (0, p0))
    # 踢腳板
    d.rectangle([0, p1, W, H], fill=(34, 20, 10))
    d.line([(0, p1), (W, p1)], fill=(90, 62, 40), width=3)
    img = img.filter(ImageFilter.UnsharpMask(1, 40, 2))
    return img


def checker():
    """黑白大理石地磚：原圖的格線有點歪，直接裁會對不齊。把一格一格的大理石剪下來，重新排成 8×8 的棋盤格，再畫上填縫"""
    a = load('tile')
    s = period(a, 1, 0.08, 0.4) / 2               # 一格的大小（重複的間距是黑白兩格）
    g = a.mean(axis=2)
    h, w = g.shape
    # 找格子的起點：格子中間的亮度一黑一白差最多的位置
    best = None
    for ox in np.linspace(0, s, 24, endpoint=False):
        for oy in np.linspace(0, s, 24, endpoint=False):
            v = 0
            for j in range(int((h - oy) // s)):
                for i in range(int((w - ox) // s)):
                    cx, cy = int(ox + (i + 0.5) * s), int(oy + (j + 0.5) * s)
                    v += g[cy, cx] * (1 if (i + j) % 2 else -1)
            if best is None or abs(v) > best[0]:
                best = (abs(v), ox, oy, v > 0)
    _, ox, oy, odd_white = best
    cells = {True: [], False: []}               # True 是白的
    for j in range(int((h - oy) // s)):
        for i in range(int((w - ox) // s)):
            x0, y0 = ox + i * s, oy + j * s
            m = s * 0.12                           # 去掉邊緣的填縫
            c = a[int(y0 + m):int(y0 + s - m), int(x0 + m):int(x0 + s - m)]
            cells[((i + j) % 2 == 1) == odd_white].append(c)
    N, C = 8, 64                                 # 8×8 格，每格 64 像素（512×512）
    out = np.zeros((N * C, N * C, 3), np.float32) + 70
    rng = np.random.default_rng(5)
    for j in range(N):
        for i in range(N):
            pool = cells[(i + j) % 2 == 0]
            c = pool[rng.integers(len(pool))]
            out[j * C:(j + 1) * C, i * C:(i + 1) * C] = np.asarray(to_img(c, (C, C)), np.float32)
    img = to_img(out, (N * C, N * C))
    d = ImageDraw.Draw(img)
    for k in range(N):
        d.line([(k * C, 0), (k * C, N * C)], fill=(88, 80, 66), width=3)
        d.line([(0, k * C), (N * C, k * C)], fill=(88, 80, 66), width=3)
    return img


def main():
    out = {}
    out['w3-wall'] = save(wall(), 'w3-wall')
    out['w3-velvet'] = save(to_img(tileable(load('velvet'), 0.1), (512, 512)), 'w3-velvet')   # 座椅每一面貼一整張，不太會重複排
    out['w3-runner'] = save(periodic('runner'), 'w3-runner')
    out['w3-carpet'] = save(periodic('lounge', lo=0.15), 'w3-carpet')
    out['w3-tile'] = save(checker(), 'w3-tile')
    out['w3-ceiling'] = save(to_img(tileable(load('ceiling'), 0.06), (512, 512)), 'w3-ceiling')
    iron = to_img(tileable(load('iron'), 0.18), (512, 512))
    out['w3-iron'] = save(iron, 'w3-iron')
    # 機車室的牆（512×1024，跟車廂的牆一樣要壓扁 0.74 倍）：鐵板一張一張往上疊
    ih = int(round(512 * 1024 / 2.7 / 512))
    iw = Image.new('RGB', (512, 1024)); it = iron.resize((512, ih), Image.LANCZOS)
    for y in range(0, 1024, ih): iw.paste(it, (0, y))
    out['w3-ironwall'] = save(iw, 'w3-ironwall')
    out['w3-herringbone'] = save(periodic('herringbone', lo=0.1), 'w3-herringbone')
    out['w3-concrete'] = save(to_img(tileable(load('concrete'), 0.25), (512, 512)), 'w3-concrete')
    if '--preview' in sys.argv:
        tiles = [v for k, v in out.items() if k not in ('w3-wall', 'w3-ironwall')]
        P = Image.new('RGB', (4 * 512, 3 * 512), (20, 20, 20))
        for i, t in enumerate(tiles):
            s = t.resize((256, 256))
            x, y = (i % 4) * 512, (i // 4) * 512
            for dx in (0, 256):
                for dy in (0, 256):
                    P.paste(s, (x + dx, y + dy))
        wl = out['w3-wall'].resize((128, 256))
        for i in range(4):
            P.paste(wl, (1024 + i * 128, 1024))
        os.makedirs(os.path.join(ROOT, 'playtest-out'), exist_ok=True)
        P.save(os.path.join(ROOT, 'playtest-out', 'photo-tex-preview.jpg'), quality=85)


main()
