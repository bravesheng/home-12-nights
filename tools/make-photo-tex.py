#!/usr/bin/env python3
# 把 Gemini 生成的原圖（generated-images/，2048×2048 的 JPEG，不放進 git）做成遊戲用的貼圖（tex/*.webp）
# 用法：python3 tools/make-photo-tex.py            → 全部重做
#       python3 tools/make-photo-tex.py --monsters → 只做怪物的材質（d-* 細節貼圖、m-* 照片）
#       python3 tools/make-photo-tex.py --preview  → 另外在 playtest-out/photo-tex-preview.jpg 拼一張 2×2 重複排的預覽（看接縫）
# 每張貼圖都要能重複排不露出接縫：
# - 規則花紋（壁紙、地毯、地磚、人字拼）：先找出花紋重複的間距，剛好裁幾個整數間距，左右上下才接得起來
# - 不規則的（絨布、水泥、鐵板）：把圖平移一半再跟原圖混合，接縫藏在中間
# 車廂的牆是一張合成圖：上面壁紙、中間黃銅線、下面胡桃木鑲板和踢腳板（跟 render3d.js 原本畫的 walnutTex 一樣的排法）
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

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
    # 第二批（2026/10/18）：家具的胡桃木、皮箱、黃銅、桌布床單，車站的灰泥和釉面磚、墨綠車身、車頂、包廂滑門、景觀車廂的地毯
    'wood': 'Gemini_Generated_Image_8mgmne8mgmne8mgm.jpeg',
    'leather': 'Gemini_Generated_Image_qz4ydyqz4ydyqz4y.jpeg',
    'brass': 'Gemini_Generated_Image_6ihf5u6ihf5u6ihf.jpeg',
    'linen': 'Gemini_Generated_Image_rb9injrb9injrb9i.jpeg',
    'plaster': 'Gemini_Generated_Image_5dlfl15dlfl15dlf.jpeg',
    'walltile': 'Gemini_Generated_Image_c58hccc58hccc58h.jpeg',
    'carbody': 'Gemini_Generated_Image_dztcoudztcoudztc.jpeg',
    'roof': 'Gemini_Generated_Image_k4z698k4z698k4z6.jpeg',
    'door': 'Gemini_Generated_Image_7x128b7x128b7x12.jpeg',      # 1536×2752（直的）
    'rug': 'Gemini_Generated_Image_xx8me7xx8me7xx8m.jpeg',       # 2752×1536（橫的）
    # 第三批（2026/10/18）：車窗外的風景（遠景、五種中景畫在洋紅色背景上，再去背）、白天的站場、時刻表、三張海報
    # 站場、時刻表、海報：第一次那段對話後半的「下載原尺寸」壞掉了，開新對話重新生成（只用原尺寸的圖，不用網頁上的預覽圖）
    'far': 'Gemini_Generated_Image_uz7g94uz7g94uz7g.jpeg',
    'mid-plain': 'Gemini_Generated_Image_rdqtq8rdqtq8rdqt.jpeg',
    'mid-trees': 'Gemini_Generated_Image_mw0ex7mw0ex7mw0e.jpeg',
    'mid-bridge': 'Gemini_Generated_Image_syuqa8syuqa8syuq.jpeg',
    'mid-snow': 'Gemini_Generated_Image_v3359lv3359lv335.jpeg',
    'mid-city': 'Gemini_Generated_Image_g1h12og1h12og1h1.jpeg',
    'yard': 'Gemini_Generated_Image_c946wsc946wsc946.jpeg',          # 正側面、沒有透視的站場（2752×1536）
    'timetable': 'Gemini_Generated_Image_wiiy64wiiy64wiiy.jpeg',     # 1792×2400
    'poster-bridge': 'Gemini_Generated_Image_xc91nxxc91nxxc91.jpeg',
    'poster-snow': 'Gemini_Generated_Image_gw9x93gw9x93gw9x.jpeg',
    'poster-meadow': 'Gemini_Generated_Image_kd6guokd6guokd6g.jpeg',
    # 第四批（2026/10/18）：怪物的材質（皮膚、鳥腳的鱗片、布、骨頭、鐵、樹皮、苔蘚、頭髮、草、獸毛、眼白、蛞蝓的皮、屍皮、
    # 兩種菇傘、菌褶、菇柄、葵花籽、花瓣、熔岩）。針織毛衣的布連續三次生成失敗，眼花女孩的毛衣用棉布
    'm-skin': 'Gemini_Generated_Image_bvetgrbvetgrbvet.jpeg',
    'm-birdleg': 'Gemini_Generated_Image_x46o8x46o8x46o8x.jpeg',
    'm-cotton': 'Gemini_Generated_Image_8ktbo8ktbo8ktbo8.jpeg',
    'm-bone': 'Gemini_Generated_Image_4cdve94cdve94cdv.jpeg',
    'm-steel': 'Gemini_Generated_Image_436nf6436nf6436n.jpeg',
    'm-rag': 'Gemini_Generated_Image_49ow6r49ow6r49ow.jpeg',
    'm-bark': 'Gemini_Generated_Image_3fm4jv3fm4jv3fm4.jpeg',
    'm-moss': 'Gemini_Generated_Image_o6tnsoo6tnsoo6tn.jpeg',
    'm-hair': 'Gemini_Generated_Image_2qenhk2qenhk2qen.jpeg',
    'm-grass': 'Gemini_Generated_Image_mq00vpmq00vpmq00.jpeg',
    'm-fur': 'Gemini_Generated_Image_8pxc7a8pxc7a8pxc.jpeg',
    'm-sclera': 'Gemini_Generated_Image_3a8yky3a8yky3a8y.jpeg',
    'm-slug': 'Gemini_Generated_Image_68c3fc68c3fc68c3.jpeg',
    'm-corpse': 'Gemini_Generated_Image_f9jzvef9jzvef9jz.jpeg',
    'm-capred': 'Gemini_Generated_Image_tcquz7tcquz7tcqu.jpeg',
    'm-cappurple': 'Gemini_Generated_Image_j1jrw3j1jrw3j1jr.jpeg',
    'm-gills': 'Gemini_Generated_Image_ojb2znojb2znojb2.jpeg',
    'm-stem': 'Gemini_Generated_Image_n2mf9in2mf9in2mf.jpeg',
    'm-seeds': 'Gemini_Generated_Image_cg85kicg85kicg85.jpeg',
    'm-petal': 'Gemini_Generated_Image_fw841zfw841zfw84.jpeg',
    'm-lava': 'Gemini_Generated_Image_unqve6unqve6unqv.jpeg',
}
FONT = '/System/Library/Fonts/Supplemental/Songti.ttc'   # 宋體（繁體 Bold 是第 2 個、Regular 是第 7 個）


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


def hpx(h):
    """牆上的高度（公尺）→ 512×1024 牆面貼圖的像素（從上往下）"""
    return int(round((1 - h / 2.7) * 1024))


def station():
    # 車站的牆（512×1024）：上面灰泥，中間一條深色的腰線，下面釉面磚（約 1.1 公尺高）
    W, H = 512, 1024
    img = Image.new('RGB', (W, H))
    pl = load('plaster')
    pl = tileable(pl[:, :int(2048 / 1.5)], 0.18, axes=(1,))
    t1 = hpx(1.12)
    img.paste(to_img(pl, (W, t1)), (0, 0))
    wt = tileable(load('walltile'), 0.04)
    img.paste(to_img(wt, (W, H - t1)), (0, t1))
    d = ImageDraw.Draw(img)
    d.rectangle([0, t1 - 14, W, t1], fill=(96, 84, 70)); d.line([(0, t1 - 14), (W, t1 - 14)], fill=(140, 126, 106), width=2)
    sh = Image.new('L', (W, 40)); sd = ImageDraw.Draw(sh)   # 天花板下面被煙燻黑
    for y in range(40): sd.line([(0, y), (W, y)], fill=int(150 * (1 - y / 40) ** 2))
    img.paste(Image.new('RGB', (W, 40), (20, 16, 12)), (0, 0), sh)
    return img


CAR_GREEN = np.array([0.6, 0.72, 0.64], np.float32)   # 生成的綠色偏灰偏淺，壓深成墨綠色


def carriage():
    # 列車面向月台的車身（512×1024）：墨綠色烤漆鋼板、兩條金線、下面黑色的底架；畫上去的窗戶跟真的窗洞一樣大（0.95～2.0 公尺、左右留 0.15）
    W, H = 512, 1024
    img = Image.new('RGB', (W, H))
    body = tileable(load('carbody'), 0.1, axes=(1,)) * CAR_GREEN
    b1 = hpx(0.59)
    img.paste(to_img(body, (W, b1)), (0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, b1, W, H], fill=(13, 14, 12))
    for y in (hpx(2.12), hpx(0.63)):
        d.rectangle([0, y - 2, W, y + 2], fill=(201, 162, 74)); d.line([(0, y - 2), (W, y - 2)], fill=(240, 210, 130))
    br = load('brass')
    x0, x1, y0, y1 = int(0.15 * W), int(0.85 * W), hpx(2.0), hpx(0.95)
    frame = to_img(br, (x1 - x0 + 24, y1 - y0 + 24))
    img.paste(frame, (x0 - 12, y0 - 12))
    gl = Image.new('RGB', (x1 - x0, y1 - y0)); gd = ImageDraw.Draw(gl)
    for y in range(y1 - y0):
        t = y / (y1 - y0); gd.line([(0, y), (x1 - x0, y)], fill=(int(28 - 20 * t), int(42 - 30 * t), int(58 - 40 * t)))
    gd.polygon([(0, y1 - y0), (int((x1 - x0) * 0.4), 0), (int((x1 - x0) * 0.55), 0), (int((x1 - x0) * 0.15), y1 - y0)], fill=(48, 62, 78))
    img.paste(gl, (x0, y0))
    return img


def cardoor():
    # 車站側的車門（256×512）：墨綠色車身、上半部黃銅框的小窗、一條金線、黃銅把手、下面一段深色
    W, H = 256, 512
    img = to_img(load('carbody')[200:1848, 600:1424] * CAR_GREEN, (W, H))
    d = ImageDraw.Draw(img)
    img.paste(to_img(load('brass'), (W - 32, 106)), (16, 24))
    d.rectangle([24, 32, W - 24, 122], fill=(11, 20, 32)); d.polygon([(30, 122), (90, 32), (120, 32), (60, 122)], fill=(30, 42, 56))
    d.rectangle([0, 278, W, 284], fill=(201, 162, 74))
    d.rectangle([0, 400, W, H], fill=(14, 15, 13))
    d.rectangle([W - 48, 300, W - 36, 360], fill=(184, 146, 58)); d.line([(W - 48, 300), (W - 48, 360)], fill=(240, 210, 130), width=2)
    return img


def key_magenta(a):
    """洋紅色背景去背：越像洋紅色越透明，邊緣的洋紅色反光也去掉"""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = np.minimum(r, b) - g                       # 洋紅色的程度
    alpha = 1 - np.clip((m - 70) / 90, 0, 1)
    spill = np.clip(m, 0, None) * (1 - alpha) * 0.9 + np.clip(m - 30, 0, None) * 0.4
    out = np.dstack([r - spill, g, b - spill, alpha * 255])
    out[..., :3] = np.clip(out[..., :3], 0, 255)
    return out


def strip(a, n, fill, size=(2048, 512)):
    """做成可以左右重複的長條：先左右接得起來，再排 n 份；內容只佔下面 fill 的高度（上面透明，才看得到後面的遠山）"""
    a = tileable(a, 0.12, axes=(1,))
    a = np.concatenate([a] * n, axis=1)
    W, H = size
    ch = int(round(H * fill))
    img = Image.new('RGBA', size, (0, 0, 0, 0))
    img.paste(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), 'RGBA').resize((W, ch), Image.LANCZOS), (0, H - ch))
    return img


def mid(name, top, n, fill):
    a = load(name)[int(load(name).shape[0] * top):]
    return strip(key_magenta(a), n, fill)


def far():
    """遠景（2048×512，不透明）：上面是跟頭頂一樣的藍天，下面接 Gemini 畫的遠山、山丘、花海（排三份，比例才不會壓扁）；地平線在 65% 的高度"""
    W, H = 2048, 512
    a = load('far')
    land = a[int(a.shape[0] * 0.36):]                # 從遠山上面一點點的天空開始
    land = np.concatenate([tileable(land, 0.15, axes=(1,))] * 3, axis=1)
    lh = 300
    limg = Image.fromarray(np.clip(land, 0, 255).astype(np.uint8)).resize((W, lh), Image.LANCZOS)
    img = Image.new('RGB', (W, H))
    top = np.array([0x3d, 0x8f, 0xe0], np.float32)
    edge = np.asarray(limg, np.float32)[:6].mean(axis=(0, 1))   # 照片天空最上面的顏色
    sky = np.zeros((H - lh, W, 3), np.float32)
    for y in range(H - lh):
        t = (y / (H - lh - 1)) ** 1.6
        sky[y] = top * (1 - t) + edge * t
    img.paste(Image.fromarray(sky.astype(np.uint8)), (0, 0))
    img.paste(limg, (0, H - lh))
    return img


def yard():
    """白天的站場（2048×512，內容佔下面八成）：站房、鐘塔、水塔只出現一次，兩邊用鐘塔和煤氣燈之間那一段（只有矮牆、花台、月台和鐵軌）接下去，才不會看到一整排一樣的站房"""
    a = load('yard')
    k = key_magenta(a[int(a.shape[0] * 0.3):])
    W, H, ch = 2048, 512, 410
    cw = int(round(k.shape[1] * ch / k.shape[0]))
    content = Image.fromarray(np.clip(k, 0, 255).astype(np.uint8), 'RGBA').resize((cw, ch), Image.LANCZOS)
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    b = np.asarray(content, np.float32)[:, int(cw * 0.76):int(cw * 0.84)]
    band = Image.fromarray(np.clip(tileable(b, 0.3, axes=(1,)), 0, 255).astype(np.uint8), 'RGBA')
    for x in range(0, W, band.size[0]):
        img.alpha_composite(band, (x, H - ch))
    x0 = (W - cw) // 2
    img.alpha_composite(content, (x0, H - ch))
    return img


def ink(img, draw_fn):
    """在舊紙上印字：字畫在另一層，再用「色彩增值」疊上去，紙的污漬和紋路會透出來"""
    layer = Image.new('RGB', img.size, (255, 255, 255))
    draw_fn(ImageDraw.Draw(layer))
    return Image.fromarray((np.asarray(img, np.float32) * np.asarray(layer, np.float32) / 255).astype(np.uint8))


def timetable():
    """時刻表（512×686）：Gemini 畫的空白表格，寫上十二個站名、到站和開車的時間、月台、備註（站名照 js/data.js 的 STATIONS_W3）"""
    import re
    src = open(os.path.join(ROOT, 'js', 'data.js'), encoding='utf-8').read()
    names = re.findall(r"'([^']+)'", re.search(r'const STATIONS_W3 = \[([^\]]+)\]', src).group(1))
    img = Image.open(os.path.join(SRC, SOURCES['timetable'])).convert('RGB')       # 1792×2400
    rows = [526, 607, 715, 823, 930, 1037, 1144, 1251, 1359, 1466, 1573, 1680, 1787, 1894]   # 表格的橫線（看圖量的）：標題列＋十二站，下面兩列空著
    cols = [232, 450, 674, 896, 1120, 1342, 1560]                                         # 六欄：序、站名、到站、開車、月台、備註
    t, times = 19 * 60, []
    steps = [0, 42, 38, 51, 36, 47, 55, 40, 63, 44, 49, 58]
    for k in range(12):
        t += steps[k]; times.append(t)
    hm = lambda m: f'{m // 60 % 24:02d}:{m % 60:02d}'
    notes = {7: '停　駛', 8: '請勿下車', 11: '終　點'}   # 備註：廢棄驛站停駛、長隧道口請勿下車
    def draw(d):
        f_title = ImageFont.truetype(FONT, 96, index=2)
        f_head = ImageFont.truetype(FONT, 50, index=2)
        f = ImageFont.truetype(FONT, 50, index=7)
        f_small = ImageFont.truetype(FONT, 42, index=7)
        ink_c = (58, 44, 34)
        def center(txt, font, x0, x1, y0, y1):
            w = d.textlength(txt, font=font); bb = font.getbbox(txt)
            d.text(((x0 + x1 - w) / 2, (y0 + y1) / 2 - (bb[1] + bb[3]) / 2), txt, font=font, fill=ink_c)
        center('末 班 列 車　時 刻 表', f_title, 330, 1460, 304, 425)
        for txt, c in (('序', 0), ('站　名', 1), ('到　站', 2), ('開　車', 3), ('月　台', 4), ('備　註', 5)):
            center(txt, f_head, cols[c], cols[c + 1], rows[0], rows[1])
        for i, n in enumerate(names):
            y0, y1 = rows[i + 1], rows[i + 2]
            center(str(i + 1), f, cols[0], cols[1], y0, y1)
            center(n, f, cols[1], cols[2], y0, y1)
            center('──' if i == 0 else hm(times[i]), f, cols[2], cols[3], y0, y1)
            center('──' if i == len(names) - 1 else hm(times[i] + 4), f, cols[3], cols[4], y0, y1)
            center('一' if i % 3 else '二', f, cols[4], cols[5], y0, y1)
            if i in notes: center(notes[i], f_small, cols[5], cols[6], y0, y1)
    return ink(img, draw).resize((512, 686), Image.LANCZOS)


def blank_band(a, y0, y1):
    """在 y0～y1 之間找最長的一段「顏色很平」的橫條（海報上留白寫標題的地方），回傳中心和高度"""
    g = a[y0:y1, int(a.shape[1] * 0.2):int(a.shape[1] * 0.8)].mean(axis=2)
    flat = (g.std(axis=1) < 9) & (g.mean(axis=1) > 170)
    best, cur, start = (0, y0), 0, 0
    for i, f in enumerate(flat):
        if f:
            if cur == 0: start = i
            cur += 1
            if cur > best[0]: best = (cur, y0 + start)
        else: cur = 0
    return best[1] + best[0] // 2, best[0]


def poster(name, title, sub, color):
    """海報（512×686）：上下留白的標題列寫上站名和標語"""
    img = Image.open(os.path.join(SRC, SOURCES[name])).convert('RGB')                # 1792×2400
    a = np.asarray(img, np.float32)
    (ty, th), (by, bh) = blank_band(a, 0, 600), blank_band(a, 1900, 2400)
    def draw(d):
        f1 = ImageFont.truetype(FONT, int(th * 0.62), index=2); f2 = ImageFont.truetype(FONT, int(bh * 0.42), index=2)
        for txt, font, y in ((title, f1, ty), (sub, f2, by)):
            w = d.textlength(txt, font=font); bb = font.getbbox(txt)
            d.text(((img.width - w) / 2, y - (bb[1] + bb[3]) / 2), txt, font=font, fill=color)
    print(f'  {name}：標題列 y={ty}（高 {th}）、標語列 y={by}（高 {bh}）')
    return ink(img, draw).resize((512, 686), Image.LANCZOS)


# ---------- 怪物 ----------
def wrap_blur(img, r):
    """可以重複排的模糊：先排成 3×3 再模糊、取中間那張，邊緣才不會糊進黑邊"""
    w, h = img.size
    big = Image.new(img.mode, (w * 3, h * 3))
    for i in range(3):
        for j in range(3):
            big.paste(img, (i * w, j * h))
    return big.filter(ImageFilter.GaussianBlur(r)).crop((w, h, 2 * w, 2 * h))


def detail(name, size=512, frac=0.2, gain=1.0, mono=False):
    """細節貼圖（d-*）：照片除以模糊過的自己，只留下細部的紋路（毛孔、裂紋、纖維、髮絲），平均是 128。
    遊戲裡乘兩倍再乘在原本的顏色上，怪物的顏色和花紋不變，只是表面變得像真的。
    mono：只留明暗（苔蘚裡的小紫花、草葉的顏色不要染到怪物身上）"""
    img = to_img(tileable(load(name), frac), (size, size))
    a = np.asarray(img, np.float32)
    b = np.asarray(wrap_blur(img, size / 24), np.float32)
    if mono:
        a, b = a.mean(axis=2, keepdims=True), b.mean(axis=2, keepdims=True)
    d = 128 * (1 + (a / np.maximum(b, 6) - 1) * gain) * np.ones((1, 1, 3), np.float32)
    d = np.clip(d, 0, 255)
    d *= 128 / d.reshape(-1, 3).mean(axis=0)        # 夾掉太亮的之後平均會偏，再拉回 128
    return Image.fromarray(np.clip(d, 0, 255).astype(np.uint8))


def sample(a, px, py, wrap_x=False):
    """雙線性內插取樣；wrap_x：左右接起來（繞一圈的角度），不然超出範圍就夾在邊上"""
    h, w = a.shape[:2]
    py = np.clip(py, 0, h - 1.001)
    if wrap_x:
        px = np.mod(px, w)
    else:
        px = np.clip(px, 0, w - 1.001)
    x0, y0 = np.floor(px).astype(int), np.floor(py).astype(int)
    x1 = (x0 + 1) % w if wrap_x else x0 + 1
    fx, fy = (px - x0)[..., None], (py - y0)[..., None]
    return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x1] * fx * (1 - fy) + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x1] * fx * fy)


def cap(name, W=1024, H=512, R=0.97, ss=2):
    """菇傘（球的上半部的貼圖：橫的是繞一圈的角度、直的是從頂上到邊緣）：從正上方拍的菇傘照片換成極座標展開，
    貼回半球上從上面看差不多就是照片。先算兩倍大再縮小，才不會鋸齒"""
    a = load(name)
    h, w = a.shape[:2]
    th = (np.arange(H * ss) + 0.5) / (H * ss) * np.pi / 2
    ph = np.arange(W * ss) / (W * ss) * np.pi * 2
    r = (th / (np.pi / 2))[:, None] * R * min(w, h) / 2    # 照弧長排（不照從上面看的距離），側面才不會被拉成一條條
    out = sample(a, w / 2 + r * np.cos(ph)[None], h / 2 + r * np.sin(ph)[None])
    return to_img(out, (W, H))


def gills(name, S=512, n=2, ss=2):
    """菇傘下面的菌褶（圓形，平面貼圖）：直條紋的照片繞成一圈（排 n 份），變成從中間往外放射的菌褶"""
    a = tileable(load(name), 0.1, axes=(1,))
    h, w = a.shape[:2]
    N = S * ss
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    dx, dy = (xx + 0.5) / N * 2 - 1, (yy + 0.5) / N * 2 - 1
    ang = np.mod(np.arctan2(dy, dx), np.pi * 2)
    out = sample(a, ang / (np.pi * 2) * w * n, np.clip(np.hypot(dx, dy), 0, 1) * (h - 1), wrap_x=True)
    return to_img(out, (S, S))


def lava():
    """熔岩暴君：照片裡發光的裂縫抓出來當自己發光的貼圖（m-lava），岩石那張（m-rock）把裂縫塗暗，
    這樣裂縫的亮度才能在遊戲裡呼吸、被聖水冷卻時變黑"""
    a = tileable(load('m-lava'), 0.15)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    hot = np.clip((r - 80) / 120, 0, 1) * np.clip((r - b - 40) / 90, 0, 1)
    hot = np.asarray(Image.fromarray((hot * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2)), np.float32)[..., None] / 255
    k = np.clip(hot * 2.5, 0, 1)                    # 裂縫邊緣的紅色也塗暗，岩石只剩黑色（光都在發光的那張）
    rock = a * (1 - k) + np.array([14, 10, 8], np.float32) * k
    glow = a * np.clip(hot * 1.4, 0, 1)
    return to_img(rock, (512, 512)), to_img(glow, (512, 512))


def monsters(out):
    # 細節貼圖：(名字, 增益, 只留明暗)；毛和頭髮的紋路本來就很強，皮膚、棉布和骨頭很淡要加強
    for n, gain, mono in (('skin', 3.2, False), ('birdleg', 1.0, True), ('cotton', 3.0, True), ('bone', 2.2, False), ('steel', 1.0, False), ('rag', 1.0, False),
                          ('bark', 0.9, True), ('moss', 0.9, True), ('hair', 1.0, True), ('grass', 0.9, True), ('fur', 1.0, True), ('sclera', 1.0, False),
                          ('slug', 1.0, False), ('corpse', 1.0, True)):
        out['d-' + n] = save(detail('m-' + n, gain=gain, mono=mono), 'd-' + n, q=72)
    out['m-capred'] = save(cap('m-capred'), 'm-capred', q=76)
    out['m-capk'] = save(cap('m-cappurple'), 'm-capk', q=76)
    out['m-gills'] = save(gills('m-gills'), 'm-gills', q=76)
    out['m-stem'] = save(to_img(tileable(load('m-stem'), 0.15), (512, 512)), 'm-stem', q=76)
    out['m-seeds'] = save(to_img(load('m-seeds'), (512, 512)), 'm-seeds', q=76)
    pt = load('m-petal')
    out['m-petal'] = save(to_img(pt[:, 512:1536], (256, 512)), 'm-petal', q=76)   # 花瓣是直的，取中間一條
    rock, glow = lava()
    out['m-rock'] = save(rock, 'm-rock', q=76)
    out['m-lava'] = save(glow, 'm-lava', q=76)


def main():
    out = {}
    if '--monsters' in sys.argv:          # 只做怪物的（比較快）
        monsters(out)
        return
    monsters(out)
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
    # 家具的材質：一個面貼一整張，不太會重複排，只要邊緣輕輕混合（混太多會出現一條條明暗帶）
    for n in ('wood', 'leather', 'linen'):
        out['w3-' + n] = save(to_img(tileable(load(n), 0.06), (512, 512)), 'w3-' + n)
    out['w3-brass'] = save(to_img(tileable(load('brass'), 0.06), (256, 256)), 'w3-brass')
    out['w3-station'] = save(station(), 'w3-station')
    out['w3-carriage'] = save(carriage(), 'w3-carriage')
    out['w3-cardoor'] = save(cardoor(), 'w3-cardoor')
    dr = load('door')
    out['w3-door'] = save(to_img(dr[:, :int(dr.shape[1] * 0.915)], (256, 512)), 'w3-door')   # 右邊多出來的門框裁掉
    out['w3-roof'] = save(to_img(tileable(load('roof'), 0.12), (512, 512)), 'w3-roof')
    out['w3-rug'] = save(to_img(load('rug'), (1024, 512)), 'w3-rug')
    out['w3-far'] = save(far(), 'w3-far', q=74)
    # 中景：(名字, 從原圖哪裡開始裁, 排幾份, 內容佔下面多少)，高度照原本程式畫的中景
    for n, top, k, fill in (('plain', 0.52, 2, 0.5), ('trees', 0.0, 3, 0.62), ('bridge', 0.0, 2, 0.85), ('snow', 0.18, 2, 0.75), ('city', 0.25, 2, 0.85)):
        out['w3-mid-' + n] = save(mid('mid-' + n, top, k, fill), 'w3-mid-' + n, q=74)
    if SOURCES['yard']: out['w3-yard'] = save(yard(), 'w3-yard', q=74)
    if SOURCES['timetable']: out['w3-timetable'] = save(timetable(), 'w3-timetable')
    for n, title, sub, col in (('bridge', '鐵 橋 頭', '末班特快　夜夜發車', (40, 60, 64)), ('snow', '雪 嶺', '冬日溫泉　山城之旅', (52, 66, 84)), ('meadow', '霧 濱', '花開的原野　等你回家', (60, 84, 60))):
        if SOURCES['poster-' + n]: out['w3-poster-' + n] = save(poster('poster-' + n, title, sub, col), 'w3-poster-' + n)
    if '--preview' in sys.argv:
        tiles = [v for k, v in out.items() if k.startswith('w3-') and v.size[0] == v.size[1] and v.mode == 'RGB']
        P = Image.new('RGB', (4 * 512, 5 * 512), (20, 20, 20))
        for i, t in enumerate(tiles):
            s = t.resize((256, 256))
            x, y = (i % 4) * 512, (i // 4) * 512
            for dx in (0, 256):
                for dy in (0, 256):
                    P.paste(s, (x + dx, y + dy))
        for j, k in enumerate(('w3-wall', 'w3-station', 'w3-carriage', 'w3-ironwall')):
            wl = out[k].resize((128, 256))
            for i in range(2):
                P.paste(wl, (j * 288 + i * 128, 4 * 512))
        P.paste(out['w3-door'].resize((128, 256)), (1200, 4 * 512)); P.paste(out['w3-cardoor'].resize((128, 256)), (1340, 4 * 512))
        P.paste(out['w3-rug'].resize((512, 256)), (1500, 4 * 512))
        os.makedirs(os.path.join(ROOT, 'playtest-out'), exist_ok=True)
        P.save(os.path.join(ROOT, 'playtest-out', 'photo-tex-preview.jpg'), quality=85)


main()
