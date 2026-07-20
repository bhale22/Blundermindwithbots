"""
Blundermind Bot Controls — Project Brief PDF Generator
"""
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.platypus import PageBreak

# ── Palette (matches Blundermind dark UI) ────────────────────────────────────
C_BG       = colors.HexColor('#1a1a2e')
C_PANEL    = colors.HexColor('#16213e')
C_AMBER    = colors.HexColor('#eb8c00')
C_AMBER_DIM= colors.HexColor('#b36d00')
C_BLUE     = colors.HexColor('#4fc3f7')
C_GREEN    = colors.HexColor('#81c784')
C_TEXT     = colors.HexColor('#e0e0e0')
C_DIM      = colors.HexColor('#9e9e9e')
C_WHITE    = colors.white
C_RULE     = colors.HexColor('#2a2a4a')
C_HEAD_BG  = colors.HexColor('#0f3460')
C_ROW_ALT  = colors.HexColor('#1e1e3a')
C_CODE_BG  = colors.HexColor('#0d1117')

# Written to the filename the server actually serves (see server.js
# /Bot_Controls_Technical_Brief.pdf and the panel's download button).
OUT = 'Bot_Controls_Technical_Brief.pdf'

doc = SimpleDocTemplate(
    OUT,
    pagesize=letter,
    leftMargin=0.75*inch, rightMargin=0.75*inch,
    topMargin=0.75*inch, bottomMargin=0.75*inch,
    title='Blundermind Bot Controls — Project Brief',
    author='Blundermind'
)

styles = getSampleStyleSheet()

def S(name, **kw):
    base = styles[name] if name in styles else styles['Normal']
    return ParagraphStyle(name + '_custom_' + str(id(kw)), parent=base, **kw)

# ── Custom styles ─────────────────────────────────────────────────────────────
sTitle   = S('Title',   fontName='Helvetica-Bold', fontSize=22, textColor=C_AMBER,
             spaceAfter=4, alignment=TA_CENTER)
sSubtitle= S('Normal',  fontName='Helvetica',      fontSize=11, textColor=C_DIM,
             spaceAfter=16, alignment=TA_CENTER)
sH1      = S('Heading1',fontName='Helvetica-Bold', fontSize=14, textColor=C_AMBER,
             spaceBefore=18, spaceAfter=4)
sH2      = S('Heading2',fontName='Helvetica-Bold', fontSize=11, textColor=C_BLUE,
             spaceBefore=10, spaceAfter=3)
sH3      = S('Heading3',fontName='Helvetica-Bold', fontSize=9,  textColor=C_GREEN,
             spaceBefore=6, spaceAfter=2)
sBody    = S('Normal',  fontName='Helvetica',      fontSize=8.5,textColor=C_TEXT,
             spaceAfter=4, leading=13, alignment=TA_JUSTIFY)
sBodyL   = S('Normal',  fontName='Helvetica',      fontSize=8.5,textColor=C_TEXT,
             spaceAfter=4, leading=13, alignment=TA_LEFT)
sDim     = S('Normal',  fontName='Helvetica-Oblique',fontSize=8,textColor=C_DIM,
             spaceAfter=3, leading=12)
sCode    = S('Code',    fontName='Courier',        fontSize=7.5,textColor=C_GREEN,
             spaceAfter=3, leading=11, backColor=C_CODE_BG,
             leftIndent=8, rightIndent=8, borderPadding=(3,6,3,6))
sLabel   = S('Normal',  fontName='Helvetica-Bold', fontSize=8,  textColor=C_AMBER)
sBullet  = S('Normal',  fontName='Helvetica',      fontSize=8.5,textColor=C_TEXT,
             leftIndent=12, spaceAfter=2, leading=12)
sNote    = S('Normal',  fontName='Helvetica-Oblique',fontSize=7.5,textColor=C_DIM,
             spaceAfter=2, leading=11, leftIndent=8)
# Table-cell paragraph styles — wrapping cells must be Paragraphs, not bare
# strings (bare strings overflow the column instead of wrapping).
sCell     = S('Normal',  fontName='Helvetica',      fontSize=7.5,textColor=C_TEXT,
             leading=9.5, spaceAfter=0, alignment=TA_LEFT)
sCellHead = S('Normal',  fontName='Helvetica-Bold', fontSize=8,  textColor=C_AMBER,
             leading=10, spaceAfter=0, alignment=TA_LEFT)

def _cellify(val, style):
    """Wrap a table-cell string in a Paragraph so it wraps within its column.
    Newlines become <br/>; existing Paragraph/flowable cells pass through."""
    if isinstance(val, str):
        return Paragraph(val.replace('\n', '<br/>'), style)
    return val

def _wrap_rows(rows, header):
    out = []
    for r, row in enumerate(rows):
        st = sCellHead if (header and r == 0) else sCell
        out.append([_cellify(c, st) for c in row])
    return out

def HR():
    return HRFlowable(width='100%', thickness=0.5, color=C_RULE, spaceAfter=6, spaceBefore=2)

def section(title):
    return [Paragraph(title, sH1), HR()]

def subsection(title):
    return [Paragraph(title, sH2)]

def sub3(title):
    return [Paragraph(title, sH3)]

def body(txt):
    return Paragraph(txt, sBody)

def bodyL(txt):
    return Paragraph(txt, sBodyL)

def code(txt):
    # Preserve intended line breaks (Paragraphs otherwise collapse \n to a space)
    return Paragraph(txt.replace('\n', '<br/>'), sCode)

def note(txt):
    return Paragraph(txt, sNote)

def dim(txt):
    return Paragraph(txt, sDim)

def bullet(txt):
    return Paragraph('• ' + txt, sBullet)

def spacer(h=6):
    return Spacer(1, h)

def attractor_table(rows, col_widths=None):
    """rows: list of lists of strings/Paragraphs"""
    if col_widths is None:
        col_widths = [1.4*inch, 1.4*inch, 1.1*inch, 1.1*inch, 2.8*inch]
    t = Table(_wrap_rows(rows, header=True), colWidths=col_widths)
    ts = TableStyle([
        ('BACKGROUND',  (0,0), (-1,0),  C_HEAD_BG),
        ('TEXTCOLOR',   (0,0), (-1,0),  C_AMBER),
        ('FONTNAME',    (0,0), (-1,0),  'Helvetica-Bold'),
        ('FONTSIZE',    (0,0), (-1,0),  8),
        ('BOTTOMPADDING',(0,0),(-1,0),  5),
        ('TOPPADDING',  (0,0),(-1,0),   5),
        ('FONTNAME',    (0,1), (-1,-1), 'Helvetica'),
        ('FONTSIZE',    (0,1), (-1,-1), 7.5),
        ('TEXTCOLOR',   (0,1), (-1,-1), C_TEXT),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[C_PANEL, C_ROW_ALT]),
        ('TOPPADDING',  (0,1), (-1,-1), 4),
        ('BOTTOMPADDING',(0,1),(-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING',(0,0), (-1,-1), 6),
        ('GRID',        (0,0), (-1,-1), 0.3, C_RULE),
        ('VALIGN',      (0,0), (-1,-1), 'TOP'),
    ])
    t.setStyle(ts)
    return t

def simple_table(rows, col_widths, header=True):
    t = Table(_wrap_rows(rows, header=header), colWidths=col_widths)
    ts = TableStyle([
        ('FONTNAME',    (0,0), (-1,-1), 'Helvetica'),
        ('FONTSIZE',    (0,0), (-1,-1), 7.5),
        ('TEXTCOLOR',   (0,0), (-1,-1), C_TEXT),
        ('ROWBACKGROUNDS',(0,0),(-1,-1),[C_PANEL, C_ROW_ALT]),
        ('TOPPADDING',  (0,0), (-1,-1), 4),
        ('BOTTOMPADDING',(0,0),(-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
        ('RIGHTPADDING',(0,0), (-1,-1), 6),
        ('GRID',        (0,0), (-1,-1), 0.3, C_RULE),
        ('VALIGN',      (0,0), (-1,-1), 'TOP'),
    ])
    if header:
        ts.add('BACKGROUND',  (0,0), (-1,0), C_HEAD_BG)
        ts.add('TEXTCOLOR',   (0,0), (-1,0), C_AMBER)
        ts.add('FONTNAME',    (0,0), (-1,0), 'Helvetica-Bold')
        ts.add('FONTSIZE',    (0,0), (-1,0), 8)
    t.setStyle(ts)
    return t

def P(txt, style=None):
    return Paragraph(txt, style or sBody)

# ═══════════════════════════════════════════════════════════════════════════════
# BUILD CONTENT
# ═══════════════════════════════════════════════════════════════════════════════
story = []

# ── Cover ─────────────────────────────────────────────────────────────────────
story += [
    spacer(30),
    Paragraph('BLUNDERMIND', sTitle),
    Paragraph('Bot Controls — Technical Project Brief', sSubtitle),
    Paragraph('Move Selection Mechanics, Formulas &amp; Architecture', sSubtitle),
    HR(),
    spacer(4),
    dim('All controls described are available in the bot-control-panel.html sidebar. '
        'Formulas reference src/50-bot-engine.js and src/60-bot-ui.js. '
        'This brief reflects the state of the dev branch as of July 2026.'),
    spacer(20),
]

# ── Table of contents (manual) ────────────────────────────────────────────────
toc_rows = [
    ['Section', 'Topic'],
    ['1', 'Architecture Overview — Move Selection Pipeline'],
    ['2', 'Move Source Layer (Opening Book / Maia3 / Stockfish / LCSF)'],
    ['3', 'Think Time Calculation'],
    ['4', 'Time Pressure Play Degradation (Independent Curves A &amp; B)'],
    ['5', 'Temperature &amp; Move Sampling'],
    ['6', 'Strategic Attractors (Centipawmeter)'],
    ['7', 'Piece-Type Attractors'],
    ['8', 'Move Distribution Filter &amp; Luck'],
    ['9', 'CP-Budget Acceptance, Degradation Guard &amp; Hard Floor (Engine-Calculated)'],
    ['10', 'Draw &amp; Desperation Behaviours'],
    ['11', 'Preset Personalities'],
    ['12', 'Time Controls'],
    ['13', 'Human Behaviour Flags'],
    ['14', 'Appendix — Play From Any Position (Replay / Loaded Games / Invites)'],
]
story.append(simple_table(toc_rows, [0.5*inch, 6.8*inch]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — ARCHITECTURE OVERVIEW
# ═══════════════════════════════════════════════════════════════════════════════
story += section('1. Architecture Overview — Move Selection Pipeline')
story += [
    body('Every bot move passes through the sequential stages below. Each stage can veto, '
         'modify, or short-circuit to skip later stages. The stages run in strict order '
         'so that think time — computed in Stage 2 — feeds every downstream degradation '
         'calculation, and so the final engine-calculation stages (8–10) see the move the '
         'personality actually chose.'),
    spacer(6),
]

pipeline = [
    ['Stage', 'Name', 'What happens'],
    ['1', 'Opening Book', 'ECO table lookup (preferred) or Lichess Masters API (mainline). '
                          'If a matching move is found, it is played immediately after a brief '
                          'book delay (400–1200 ms). Skipped once the game leaves known lines.'],
    ['2', 'Think Time', 'Actual think time for this move computed from timing mode + '
                        'Hustle attractor + clock pressure. Result fed as thinkSec into '
                        'all downstream degradation curves.'],
    ['3', 'Engine Query', 'Rough thinkSec estimate used to pick Maia ELO (curve A, if the '
                          'ELO-degradation toggle is on). Maia3 or LCSF queried for candidate '
                          'move probabilities.'],
    ['4', 'Distribution Filter', 'Absolute min-probability floor removes near-zero candidates. '
                                 'Curve B (if the distribution toggle is on) narrows the upper '
                                 'percentile; the Luck attractor shifts the window (§8).'],
    ['5', 'Attractor Reweighting', 'Each candidate move\'s probability is multiplied by '
                                    'exp(logBoost) where logBoost is the sum of all active '
                                    'strategic attractor signals. Sets an "applied" flag read '
                                    'by Stage 8.'],
    ['6', 'Desperation (opt.)', 'If "seek stalemate when losing" is armed and the engine eval '
                                'confirms a lost position, candidate weights are re-shaped '
                                'toward low-own-mobility and material-dumping moves (§10).'],
    ['7', 'Conviction Pick', '30% of moves: the top-ranked move of the reweighted distribution '
                             'is played outright (argmax). The other 70%: final temperature '
                             'applied (base T × phase/pressure modifiers) and one move is '
                             'sampled (§5).'],
    ['8', 'CP-Budget Acceptance', 'Personality bots only: if the pick differs from '
                                   'Maia\'s most-popular move, a shallow Stockfish probe checks '
                                   'that the pick loses ≤ CP budget vs the popular move; '
                                   'otherwise it walks down the preference order (§9a).'],
    ['9', 'Degradation Guard', 'Bad-Day / distribution-restricted picks are re-checked so a '
                                'degraded choice can never out-perform Maia\'s top move — '
                                'popularity is not quality (§9b).'],
    ['10', 'Hard Floor Backstop', 'Whatever mechanism produced the final pick, it may not lose '
                                  'more than the Hard Floor vs the popular move (unless the '
                                  'Floor is Off). Budget-cleared picks skip the check (§9c).'],
]
story.append(simple_table(pipeline, [0.4*inch, 1.25*inch, 5.65*inch]))
story.append(spacer(8))

story += [
    body('<b>Key architectural principle #1 — think time drives degradation:</b> Think time '
         'is computed first (Stage 2), and the resulting thinkSec value drives Stages 3–4 via '
         'the degradation curves. A Coffeehouse Hustler thinking 0.3 s on a move sees heavy '
         'ELO and distribution degradation on that specific move — not an average derived from '
         'the remaining clock.'),
    spacer(4),
    body('<b>Key architectural principle #2 — real centipawns, not probability:</b> Maia '
         'probability measures how <i>popular</i> a move is at a rating, which is not the same '
         'as how <i>good</i> it is — at low ratings the two can even anticorrelate. Therefore '
         'the CP budget and all quality guarantees are enforced with actual Stockfish '
         'evaluations at Stages 8–10, never by treating a probability ratio as a centipawn '
         'value. Stages 8–9 run only for personality bots; the Hard Floor backstop covers '
         'every bot. All are fail-open (any probe timeout leaves the pick untouched).'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — MOVE SOURCE LAYER
# ═══════════════════════════════════════════════════════════════════════════════
story += section('2. Move Source Layer')
story += subsection('2a. Opening Book')
story += [
    body('Two independent book modes are available. Either can be active simultaneously; '
         'each deactivates permanently the first time it fails to find a candidate move.'),
    spacer(4),
]

book_rows = [
    ['Mode', 'Source', 'Behaviour'],
    ['Preferred', 'In-memory ECO table (~3 000 named openings)',
     'Matches game history against ECO lines whose ECO code or family prefix is in '
     'the bot\'s slot list. Plays the next move from the highest-priority matching line. '
     'Exits the book at maxBookDepth (default 20 half-moves).'],
    ['Mainline', 'Lichess Masters API (live)',
     'Queries masters database for the most popular continuation from the current '
     'position. Falls back to Lichess database if no masters result. Plays the top-weighted '
     'move. Deactivates after the first cache miss or API error.'],
]
story.append(simple_table(book_rows, [1.0*inch, 1.8*inch, 4.5*inch]))
story += [spacer(4), note('Book delay: 400–1200 ms random pause to simulate human reading time.')]

story += subsection('2b. Maia3 Neural Network')
story += [
    body('Maia3 is a series of neural networks (600–2600 ELO) trained to predict human '
         'moves at each rating level. The bot queries the appropriate ELO model (determined '
         'by degradation curve A) and receives a probability distribution over all legal moves.'),
    bullet('Model selection: effective ELO = pressureEffectiveMaiaEloByThink(thinkSec)'),
    bullet('ELO clamped to [600, 2600].'),
    bullet('Probability distribution filtered by the distribution range (§8), then reweighted by attractors (§6).'),
]

story += subsection('2c. Stockfish (SF) Engine')
story += [
    body('Used when the bot engine mode is set to Stockfish. Skill level 1–20 controlled '
         'by sfEffectiveLevel(). The engine is queried via WebWorker; MultiPV probes '
         'provide complexity scores used by the Chaos attractor.'),
    code('sfEffectiveLevel: floor = pressureFloor\n'
         'pressureFloor = max(1, startLevel − round(timePressureMaxDrop / 50))\n'
         '  (or the sfPressureLevel slider when no max-drop is set)'),
    note('The old blunder-limit-derived quality floor was removed — single-move quality is '
         'now guaranteed by the engine-calculated CP budget and the Hard Floor backstop '
         '(§9), not by a Stockfish skill floor.'),
    body('Time degradation path (highest priority wins):'),
    bullet('Weaponizer active AND bot is ahead → return floor immediately'),
    bullet('Curve A present → spline interpolation in log-time space → lerp level to floor'),
    bullet('Fallback: linear ramp from startLevel at 30 s → floor at 0 s'),
]

story += subsection('2d. Level-Controlled Stockfish (LCSF)')
story += [
    body('LCSF uses Stockfish with controlled skill variation rather than Maia probability '
         'distributions. sfPickLevel() distributes calls around the target level:'),
    code('p(offset) distribution:\n'
         '  −2: var2/2  (e.g. 10% at ±2 → 5% chance)\n'
         '  −1: var1/2  (e.g. 30% at ±1 → 15% chance)\n'
         '   0: 1 − var1 − var2  (remaining probability)\n'
         '  +1: var1/2\n'
         '  +2: var2/2\n'
         'Level clamped to [1, 20]'),
    body('<b>var1</b> (±1 spread): 0–50%. &nbsp;<b>var2</b> (±2 spread): 0–20%. '
         'Setting both to 0 uses the exact target level every move.'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — THINK TIME
# ═══════════════════════════════════════════════════════════════════════════════
story += section('3. Think Time Calculation')
story += [
    body('Think time is calculated in botThinkTime(moveProbs, clockMs) before the engine '
         'is queried. The result (thinkSec) drives all downstream degradation curves, '
         'so attractors that shorten think time (Hustler) directly increase move-quality '
         'degradation for that specific move.'),
    spacer(4),
]

story += subsection('3a. Timing Modes')
mode_rows = [
    ['Mode', 'Formula / Behaviour'],
    ['Instant', 'Returns 0 ms. No delay whatsoever.'],
    ['Fixed', 'thinkMs = botFixedDelayMs. Capped at min(fixed, clockMs × 0.08) when '
              'clock < 30 s. Capped at clockMs − 3 s when flagging is disabled.'],
    ['Pace (default)', 'baseSec = (5 × 60) / pace. '
                       'complexity = min(1 + entropy × 0.35, 2.5). '
                       'thinkMs = baseSec × complexity × 1000. '
                       'Pace slider: 5–120 (moves per 5 min equivalent).'],
    ['Complexity', 'cplx = sfCplxScore if available, else min(1, entropy / 4). '
                   'mult = botCplxMin + cplx × (botCplxMax − botCplxMin). '
                   'thinkMs = botCplxBase × mult × 1000. '
                   'Explicit base / min-mult / max-mult sliders in panel.'],
    ['Mirror', 'avg = rolling average of human move timestamps. '
               'thinkMs = avg × jitter(0.8–1.2) × (1 + mirrorOffsetPct/100). '
               'Falls through to Complexity/Pace when no human moves recorded yet.'],
]
story.append(simple_table(mode_rows, [1.2*inch, 6.1*inch]))

story += [spacer(6)]
story += subsection('3b. Think Time Modifiers (applied in order)')
mod_rows = [
    ['Modifier', 'Condition', 'Effect'],
    ['Weaponizer shortcut', 'Enabled AND bot clock > opp clock + leadMs',
     'Return 0 ms immediately (skip all delays)'],
    ['Move blink', 'botBehavBlink AND entropy < 0.5 (forced/obvious positions)',
     '200–500 ms random; skips further calculation'],
    ['Clock-pressure mirroring', 'botBehavClockMirror AND oppClock < botClock × 0.6',
     'thinkMs ×= 0.5'],
    ['Hustle attractor', 'value v ∈ [−5, +5]',
     'thinkMs ×= (1 − v × 0.15). At +5: ×0.25 (very fast). At −5: ×1.75 (very slow).'],
    ['Reconsideration', 'botBehavReconsider, 15% random chance',
     'thinkMs ×= 1.5 to 2.5 (hesitation pause)'],
    ['Base jitter', 'Always applied',
     'thinkMs ×= uniform(0.8, 1.2)'],
    ['Clock cap (low clock)', 'clockMs < 30 000 ms',
     'thinkMs = min(thinkMs, clockMs × 0.08)'],
    ['Flagging guard', 'botCanFlag = false',
     'thinkMs = min(thinkMs, max(200, clockMs − 3000))'],
    ['Global cap', 'Always applied',
     'thinkMs = max(200, min(botThinkCapMs(), thinkMs)). '
     'Cap = max(6 s, min(45 s, startClock × 0.02)) — scales with time control.'],
]
story.append(simple_table(mod_rows, [1.4*inch, 1.8*inch, 4.1*inch]))
story.append(spacer(4))
story.append(note('Position entropy is Shannon entropy over Maia move probabilities: '
                  'H = −Σ p·log₂(p). Higher entropy = more complex / branching position.'))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — PRESSURE DEGRADATION CURVES
# ═══════════════════════════════════════════════════════════════════════════════
story += section('4. Time Pressure Play Degradation')
story += [
    body('Two independent user-editable spline curves control how the bot\'s play quality '
         'degrades as think time per move decreases. Both curves use log-scale interpolation '
         'on the X axis (think time in seconds) so that the visually equal spacing on the '
         'panel matches the mathematical interpolation.'),
    spacer(4),
    body('<b>Each curve has its own ON/OFF toggle</b> beside its chart, so the two mechanisms '
         'are fully independent: ELO degradation (curve A) reduces the Maia ELO the engine is '
         'queried at, while distribution restriction (curve B) keeps the ELO fixed but narrows '
         'which slice of Maia\'s move distribution is available. You can run either alone, both '
         'together, or switch both off for constant strength. When a curve is off it is flat at '
         'its reference value (curve A at the configured ELO, curve B at 100%), and its slider '
         'no longer re-anchors the other curve.'),
    spacer(4),
    code('Curve interpolation (log-x space):\n'
         '  pts sorted by x. For xSec in [pts[i].x, pts[i+1].x]:\n'
         '  t = (ln(xSec) − ln(pts[i].x)) / (ln(pts[i+1].x) − ln(pts[i].x))\n'
         '  y = pts[i].y + t × (pts[i+1].y − pts[i].y)'),
    spacer(6),
]

story += subsection('Curve A — ELO Degradation')
story += [
    body('Maps think time (s) → effective Maia ELO. '
         'At full think time the bot queries its configured ELO tier. '
         'As think time shrinks the ELO drops, producing weaker move distributions.'),
    code('effectiveELO = pressureEffectiveMaiaEloByThink(thinkSec)\n'
         '             = evalPressureCurve(curveA, thinkSec)  clamped to [600, 2600]'),
    bullet('X axis: think time per move in seconds (log scale, typically 0.1 s – 30 s)'),
    bullet('Y axis: Maia ELO (600 – 2600)'),
    bullet('Default: flat at configured ELO (no degradation) unless curve is set'),
    note('The rough thinkSec estimate (computed before the Maia query) is used for ELO selection. '
         'The precise thinkSec (after the engine responds) is used for curve B and temperature.'),
]

story += subsection('Curve B — Distribution Cutoff')
story += [
    body('Maps think time (s) → upper percentile cutoff of the move candidate list. '
         '100% = full distribution (top candidate down to last). '
         'As think time falls the cutoff drops — forcing the bot to pick from a narrower '
         'top slice of the distribution (higher-probability, safer-looking moves).'),
    code('effectiveUpperPct = pressureEffectiveDayUpperByThink(thinkSec)\n'
         '                  = min(botDayUpper, evalPressureCurve(curveB, thinkSec))'),
    bullet('X axis: think time per move in seconds (log scale)'),
    bullet('Y axis: upper percentile 0–100%'),
    bullet('Combined with the Move Distribution Range lower bound and Luck shift (§8)'),
]

story += subsection('Time Pressure Temperature Boost')
story += [
    body('In addition to ELO and distribution effects, low think time raises the sampling '
         'temperature, making move selection more random under pressure:'),
    code('timePressureTempByThink(baseTemp, thinkSec):\n'
         '  boost = { steady: 0.0, normal: 1.0, panicky: 2.5 }[botTimePressure]\n'
         '  if curveB present:\n'
         '    fraction = 1 − evalPressureCurve(curveB, thinkSec) / 100\n'
         '  else:\n'
         '    fraction = max(0, 1 − thinkSec / 30)   # linear fallback\n'
         '  effectiveTemp = baseTemp + fraction × boost'),
    note('botTimePressure modes: "steady" (no boost), "normal" (+1.0 max), "panicky" (+2.5 max).'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — TEMPERATURE & SAMPLING
# ═══════════════════════════════════════════════════════════════════════════════
story += section('5. Temperature & Move Sampling')
story += [
    body('After attractor reweighting, the <b>conviction pick</b> decides how the move is '
         'chosen: 30% of the time the bot plays the top-ranked move of the reweighted '
         'distribution outright (argmax — its personality\'s honest first choice); the other '
         '70% of the time one move is sampled using temperature-scaled probabilities. '
         'Temperature T controls how peaked or flat the distribution is before sampling.'),
    code('pickFromProbs(moveProbs, T):\n'
         '  if rand() < 0.30 → return argmax of reweighted distribution\n'
         '  else sampleFromProbs(moveProbs, T):\n'
         '    scaled[m] = prob[m] ^ (1/T)\n'
         '    total = Σ scaled[m]\n'
         '    sample r ~ Uniform(0, total)\n'
         '    return first m where cumulative sum ≥ r'),
    body('At T=1.0 the original Maia probabilities are used directly. '
         'T < 1 sharpens the distribution (top move more likely). '
         'T > 1 flattens it (unlikely moves become relatively more likely). '
         'T is clamped to ≥ 0.1 to prevent division issues.'),
    spacer(6),
]

story += subsection('5a. Base Temperature Presets')
temp_rows = [
    ['Preset', 'T value', 'Behaviour'],
    ['Focused',  '0.4', 'Strongly favours top 1–2 Maia moves'],
    ['Neutral',  '1.0', 'Samples Maia\'s full distribution as-is'],
    ['Varied',   '1.8', 'Wider sample — more surprise choices'],
    ['Wild',     '3.0', 'Even low-probability moves get meaningful weight'],
]
story.append(simple_table(temp_rows, [1.2*inch, 0.8*inch, 5.3*inch]))

story += [spacer(6)]
story += subsection('5b. Hustler Phase Temperature')
story += [
    body('When the Coffeehouse Hustler personality is active (personalityId = "hustler"), '
         'the base temperature is replaced by a phase-sensitive curve:'),
    code('hustlerPhaseTemp():\n'
         '  piecesLeft = count of non-pawn, non-king pieces on board\n'
         '  fraction   = clamp(1 − (piecesLeft − 4) / 10, 0, 1)\n'
         '               # 0 at 14 pieces (opening), 1 at ≤4 pieces (endgame)\n'
         '  T = 5.0 + fraction × (0.6 − 5.0)\n'
         '    = 5.0 in opening → 0.6 in endgame'),
    note('14 non-pawn/non-king pieces = full material. At 4 or fewer such pieces, '
         'the endgame temperature floor of 0.6 is reached.'),
]

story += subsection('5c. Complexity-Adjusted Temperature')
story += [
    body('For Maia3 mode, the base temperature can optionally be scaled by position '
         'complexity (MultiPV evaluation spread):'),
    code('complexityAdjustedTemp(baseT):\n'
         '  if sfCplxScore is null → return baseT\n'
         '  cplxFactor = 0.8 + sfCplxScore × 0.4   # 0.8 at simple, 1.2 at complex\n'
         '  return baseT × cplxFactor'),
    note('sfCplxScore is the normalized std. deviation of the top-N Stockfish evaluations, '
         'ranging 0 (all moves equal) to 1 (widely spread evaluations).'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — STRATEGIC ATTRACTORS
# ═══════════════════════════════════════════════════════════════════════════════
story += section('6. Strategic Attractors (Centipawmeter)')
story += [
    body('Strategic attractors reweight each candidate move\'s probability by multiplying '
         'it by exp(logBoost). The total logBoost for a move is the sum of all active '
         'attractor contributions. Attractors are zero at centre and scale linearly '
         'with slider value (−5 to +5).'),
    spacer(4),
]

story += subsection('6a. CP Budget, Hard Floor and Scale Factor')
story += [
    body('The CP (centipawn) budget (0–300), shown on the Centipawmeter dial, is a single '
         'master gain knob for all attractors. It controls how strongly attractors push the '
         'distribution, regardless of the individual slider positions. The budget also names '
         'a <b>real, engine-calculated centipawn ceiling</b> on how far a move may fall below '
         'Maia\'s most-popular choice — that guarantee is enforced at Stage 8 (§9), not by the '
         'internal 150-cp-per-log-unit scale factor below, which only sets the push strength.'),
    body('The <b>Hard Floor</b> (Budget–1000 cp, or Off at the top of the slider) sits '
         'directly beneath the Budget and is always ≥ Budget. It is the absolute backstop on '
         'every <i>other</i> selection mechanism — temperature sampling, the Luck window '
         'shift, Bad Day, curve-B time-pressure restriction — enforced by '
         'applyHardFloorBackstop (§9c). At Off, nothing is capped: a beginner bot can '
         'genuinely hang its queen.'),
    body('The Engine panel shows both values beside the Elometer with a one-click ELO-scaled '
         'recommendation. Budget and Floor have separate curves: Budget ≈ (2700 − ELO)/15 '
         'clamped to 10–120 cp (the persistent per-move style spend, a fraction of the '
         'rating\'s typical centipawn loss), Floor ≈ (2900 − ELO)/4.5 clamped to 80–520 cp '
         '(the worst single move still in character for the rating).'),
    code('totalAbs = Σ |v| for all attractor and piece sliders\n'
         'scale    = cpBudget / (totalAbs × 150)   if cpBudget > 0 and totalAbs > 0\n'
         '         = 0                              otherwise\n\n'
         'For each move: prob_new = prob × exp(logBoost)\n'
         '  where logBoost = Σ (attractor_v × scale × signal)\n\n'
         'At cpBudget=150 with one slider at 1 and all others at 0:\n'
         '  scale = 1/150, signal = 1 → logBoost = 1 → exp(1) ≈ 2.7× boost'),
    note('Allocating 150 cp of budget on a single maximally-set attractor produces roughly '
         'a 2.7× probability boost on moves that fully satisfy that attractor.'),
    spacer(6),
]

story += subsection('6b. Attractor Formulas')

attr_rows = [
    ['Attractor', 'Left (−) / Right (+)', 'Signal formula', 'Notes'],
    ['Chaos Agent\n/ Simplifier',
     '− Simplifier → low-σ moves\n+ Chaos Agent → high-σ moves',
     'logBoost += chaosVal × scale × signal\n(signal from MultiPV σ)',
     'Requires MultiPV Stockfish probe. '
     'σ = std. dev. of top-N eval scores.'],
    ['Complicate\n/ Simplify winning',
     '− Simplify when winning\n+ Complicate when winning',
     'Active when eval ≥ +100 cp.\nBoosts moves that increase or\ndecrease MultiPV variance.',
     'Only fires in clearly winning positions. '
     'Combined with Chaos Agent for full effect.'],
    ['Space Cadet\n/ Space Waster',
     '− Space Waster → cede space\n+ Space Cadet → reduce weak sq.',
     'delta = currentWeakSq − simWeakSq\nlogBoost += v × scale × tanh(delta/5)',
     'Full board attack map computed on simulated position. '
     'Captures discovered attacks and blocking moves. '
     'delta > 0 = fewer weak squares after move.'],
    ['Fort Knox\n/ Glass Cannon',
     '− Glass Cannon → exposed pieces\n+ Fort Knox → more defenders',
     'delta = simTotalDefs − currentDefs\nlogBoost += v × scale × tanh(delta/3)',
     'Counts sum of defensive coverage across all bot pieces. '
     'Full board attack map on simulated position.'],
    ['Gambito\n/ Gambit Shy',
     '− Gambit Shy → avoid sacrifices\n+ Gambito → follow gambit lines',
     'Opening only (< 20 half-moves).\nECO: logBoost += v × scale if\nmove is ECO gambit continuation.\nFallback: pawn to attacked, undefended sq.',
     'ECO gambit line match takes priority. '
     'Structural fallback if ECO data not yet loaded.'],
    ['Trade Seeker\n/ Trade Avoider',
     '− Trade Avoider → no captures\n+ Trade Seeker → captures',
     'Capture: logBoost += v × scale\nThreat: logBoost += v × scale\n  × tanh(newThreats / 2)',
     'Non-captures scored by number of new opponent-piece threats created from destination square.'],
    ['Rigid / Loose\nPawn Structure',
     '− Loose → open mobile structure\n+ Rigid → tighter structure',
     'Own pawn moves only.\ndelta = currentPenalty − simPenalty\nlogBoost += v × scale × tanh(delta)',
     'Penalty = pawn islands + doubled pawns + isolated pawns. '
     'delta > 0 = move tightens structure.'],
    ['Coffeehouse\nHustler /\nOverthinker',
     '− Overthinker → longer think time\n+ Hustler → shorter think time',
     'Applied to think time (not prob):\nthinkMs ×= (1 − v × 0.15)',
     'At +5: ×0.25 (4× faster). At −5: ×1.75 (75% slower). '
     'Feeds into pressure curves as actual thinkSec.'],
    ['Luck /\nBad Day',
     '− Good day → top of distribution\n+ Bad day → bottom of distribution',
     'Shifts distribution window:\nlo = botDayLower − v × 4\nhi = _pressureUpper − v × 4',
     'See §8 Move Distribution Range for full description.'],
    ['Panicky /\nCalm under pressure',
     '− Calm → no temperature boost\n+ Panicky → larger T boost under pressure',
     'Modifies timePressure boost mode.\n(steady / normal / panicky)',
     'See §4 Pressure Temperature Boost.'],
    ['Attacker\n/ Peacemaker',
     '− Peacemaker → quiet positions\n+ Attacker → maximize threats',
     'totalThreats = Σ attacks on each opp. piece\nlogBoost += v × scale × tanh(threats/6)',
     'Full board attack map on simulated position. '
     'Counts attack coverage across all opponent pieces.'],
]
story.append(attractor_table(attr_rows,
    col_widths=[1.1*inch, 1.5*inch, 1.9*inch, 2.8*inch]))
story.append(spacer(4))
story.append(note('All attractor signals that use tanh map their input to a smooth −1..+1 range, '
                  'preventing any single move from receiving an unbounded boost.'))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — PIECE ATTRACTORS
# ═══════════════════════════════════════════════════════════════════════════════
story += section('7. Piece-Type Attractors')
story += [
    body('Six independent sliders (−5 to +5) bias the bot toward or away from moving '
         'each piece type. The formula is the same for all six:'),
    code('logBoost += pieceVals[pieceType] × scale'),
    body('The piece type is determined from the moving piece before the move. '
         'The signal is 1 (or 0 for no boost) — there is no continuous signal function '
         'as with most strategic attractors. Scale is shared with the strategic attractors '
         'so the CP budget controls piece attractor strength alongside everything else.'),
    spacer(6),
]

piece_rows = [
    ['Piece', 'Left (−) behaviour', 'Right (+) behaviour', 'Best combined with'],
    ['Pawn ♙',   'Suppress pawn moves', 'Prioritise pawn advances', 'Rigid structure (connected chains)'],
    ['Knight ♘', 'De-prioritise knight hops', 'Knight manoeuvres first', 'Rigid structure (closed positions)'],
    ['Bishop ♗', 'Keep bishops passive', 'Diagonal play, bishop pair', 'Loose structure (open diagonals)'],
    ['Rook ♖',   'Passive rooks, avoid early trades', 'File seizure, rook lifts', 'Open files, trade-seeker'],
    ['Queen ♕',  'Conservative queen, avoid exposure', 'Active queen, queen-led attacks', 'Chaos Agent (keeps complications)'],
    ['King ♔',   'King safety, stay castled', 'King activity, endgame aggression', 'Endgame positions, low piece count'],
]
story.append(simple_table(piece_rows, [0.7*inch, 1.5*inch, 1.5*inch, 2.6*inch]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — MOVE DISTRIBUTION RANGE & LUCK
# ═══════════════════════════════════════════════════════════════════════════════
story += section('8. Move Distribution Filter & Luck')
story += [
    body('The Move Distribution Range dual slider selects which segment of the Maia probability-'
         'ranked candidate list the bot samples from. Candidates outside the [lower, upper] '
         'percentile window are excluded before temperature sampling and attractor reweighting.'),
    note('The ranking is popularity, not engine quality — Maia probability is how '
         'often players at the selected rating choose a move. A strong move few players see can '
         'sit low in the distribution; real move-quality enforcement is the engine check in §9.'),
    spacer(4),
]

story += subsection('8a. Percentile Band Filtering')
story += [
    code('sorted candidates by probability (highest first)\ncumulative probability sum = total\n\n'
         'band.lo = (lo/100) × total\nband.hi = (hi/100) × total\n\n'
         'Include move m if: cumulative_end(m) > band.lo AND cumulative_start(m) < band.hi'),
    body('Default: lo = 0%, hi = 100% (full distribution). '
         'Setting lo = 20%, hi = 60% samples only the middle tier — avoiding '
         'the top moves (too accurate) and the worst moves (random blunders).'),
]

story += subsection('8b. Luck Attractor Shift')
story += [
    body('The Luck attractor shifts both bounds of the quality window simultaneously:'),
    code('lo_effective = botDayLower − luckVal × 4\n'
         'hi_effective = pressureUpper − luckVal × 4\n\n'
         'luckVal > 0 (Bad day): window shifts down → samples lower-ranked moves → worse play\n'
         'luckVal < 0 (Good day): window shifts up → samples top-ranked moves → sharper play'),
    note('pressureUpper is the curve-B degraded upper bound, so luck shift compounds '
         'with time pressure effects.'),
]

story += subsection('8c. Min-Probability Filter')
story += [
    body('A single absolute-popularity filter prunes the candidate list before the distribution '
         'range is applied. (The former relative "blunder-limit" cutoff — which pretended a '
         'probability ratio was a centipawn value — has been removed; centipawn enforcement is '
         'now the engine-calculated check in §9.)'),
    code('absFloor = minProbPct / 100\n'
         'keep only moves with prob ≥ absFloor\n'
         '(if that empties the list, keep the single most-popular move)'),
    bullet('minProbPct (the "Exclude lowest %" slider): absolute probability floor; removes '
           'near-zero candidates. This is an honest distribution control, expressed as a '
           'percentage, with no pretence of measuring quality.'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — CP-BUDGET ACCEPTANCE & DEGRADATION GUARD
# ═══════════════════════════════════════════════════════════════════════════════
story += section('9. CP-Budget Acceptance, Degradation Guard & Hard Floor (Engine-Calculated)')
story += [
    body('Maia probability is popularity, not quality. Three post-sampling stages use a '
         'shallow Stockfish probe to hold the played move to a real centipawn standard. '
         'The first two run only for personality bots (they need the Stage-5 reweighting '
         'flag); the Hard Floor backstop (§9c) covers picks from <i>any</i> mechanism. All '
         'run only when the pick differs from Maia\'s most-popular move, and all are '
         'fail-open — any probe failure or timeout leaves the pick unchanged. The probe '
         'reuses the MultiPV complexity machinery with a searchmoves restriction (depth ~10; '
         'the timeout scales with candidate count, capped at 4.5 s).'),
    spacer(6),
]

story += subsection('9a. CP-Budget Acceptance — applyCpBudgetAcceptance()')
story += [
    body('Turns the Centipawmeter into a real centipawn ceiling. When personality reweighting '
         'produced a pick different from the most-popular move, the pick, the popular move, and '
         'a wide slice of the personality\'s preference order (up to 15 moves, one combined '
         'MultiPV probe) are evaluated together. The pick is accepted only '
         'if it loses no more than the CP budget versus the popular move; otherwise the bot '
         'walks down its own preference order until one fits, falling back to the popular move '
         'itself (0 cp by definition).'),
    code('topMove   = argmax Maia probability\n'
         'if pick == topMove or reweighting not applied → keep pick\n'
         'evals = SF probe over [topMove, pick, next favourites]\n'
         'for m in [pick, ...favourites]:\n'
         '    if evals[topMove] − evals[m] ≤ cpBudget → play m\n'
         'else → play topMove'),
    note('Stalemate-seeking picks (§10) are deliberately exempt — throwing material is the '
         'whole point, so the budget must not veto them.'),
]

story += subsection('9b. Degradation Guard — applyDegradationEvalGuard()')
story += [
    body('Guarantees that a deliberately degraded choice never accidentally out-performs '
         'Maia\'s top move. It is active when Grandmaster Bad Day is on, or when the '
         'time-pressure distribution restriction (curve B) is actively narrowing the window. '
         'The chosen move and the most-popular move are evaluated, and whichever scores '
         '<i>worse</i> is played.'),
    code('active if botBadDayMode OR curve-B is narrowing now\n'
         'if pick == topMove → keep\n'
         'evals = SF probe over [pick, topMove]\n'
         'play the move with the LOWER eval'),
    note('Consequence: Grandmaster Bad Day picks the lowest-probability move above the '
         'min-probability slider\'s floor (the preset sets 4%), but if that move happens to be '
         'strong (a shot few players see), the guard swaps it back to the mainstream move — '
         'the bot is never accidentally brilliant.'),
]

story += subsection('9c. Hard Floor Backstop — applyHardFloorBackstop()')
story += [
    body('Runs last in the pick flow and bounds how far below Maia\'s most-popular move ANY '
         'final pick may fall — whatever produced it: temperature sampling, the Luck window '
         'shift, Bad Day, curve-B time-pressure restriction, or plain sampling variance. '
         'Skipped when the pick was already engine-calculated within the Budget (Budget ≤ '
         'Floor by invariant), when the Floor slider is at Off (≥ 1000 cp), and for '
         'stalemate-seeking desperation picks. Reuses the degradation guard\'s probe when one '
         'was taken for the same position; otherwise pays for one shallow probe of its own.'),
    code('floor = hardFloorCp (panel slider, Budget–1000; ≥ 1000 → Off)\n'
         'if budget-verified this move, or floor Off, or pick == topMove → keep\n'
         'evals = SF probe over [pick, topMove] (or reuse guard probe)\n'
         'if evals[topMove] − evals[pick] > floor → play topMove\n'
         'else → keep pick'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — DRAW & DESPERATION BEHAVIOURS
# ═══════════════════════════════════════════════════════════════════════════════
story += section('10. Draw & Desperation Behaviours')
story += [
    body('Four opt-in behaviours (in the Move Timing section\'s "Draws & desperation" group) '
         'let a bot handle draw offers, offer draws, and swindle when lost — all judged the way '
         'a human of the bot\'s strength would, not at raw engine accuracy.'),
    spacer(6),
]

story += subsection('10a. Perceived Evaluation — botPerceivedAdvantageCp()')
story += [
    body('Every draw decision uses the bot\'s <b>perceived</b> advantage, not Stockfish\'s. '
         'A shallow eval probe gives the true centipawn advantage from the bot\'s side; that '
         'value is then blurred by rating-scaled Gaussian noise plus a mild self-optimism bias. '
         'A novice genuinely misjudges; a master barely does.'),
    code('sigma(elo) = 15 + 700 × exp(−elo / 500)\n'
         '   ≈ 225 cp at 600 ELO,  ≈ 50 cp at 1500,  ≈ 19 cp at 2600\n'
         'perceived = trueAdv + gauss()×sigma + 0.25×sigma'),
    note('So a 700-rated bot can believe a lost position is fine (and decline your draw, or '
         'offer one from a losing position it thinks is level); a 2400 is almost never fooled.'),
]

story += subsection('10b. Accepting & Offering Draws')
draw_rows = [
    ['Behaviour', 'Control', 'Rule'],
    ['Accepts draw offers', 'toggle + accept-margin (0–300 cp)',
     'On your ½ offer the bot accepts iff its <i>perceived</i> advantage ≤ margin. '
     'Declines are wordless (a human just plays on — no eval is announced), and a bot that '
     'knows it is worse may still decline, hoping for a blunder.'],
    ['Offers draws', 'toggle + level-band (±cp) + from-move',
     'After its move, in a position that <i>feels</i> level (|perceived| ≤ band) and past the '
     'move threshold, it occasionally offers — never twice within 12 plies.'],
]
story.append(simple_table(draw_rows, [1.4*inch, 1.9*inch, 4.0*inch]))

story += [spacer(6)]
story += subsection('10c. Clock Awareness')
story += [
    body('Draw decisions read the clock (only when the increment is under 10 s, since nobody '
         'flags with a healthy increment):'),
    bullet('<b>Opponent about to flag</b> (under 20 s, bot comfortably ahead on time): the bot '
           'declines instantly with no eval probe and never offers — it is playing for the win '
           'on time.'),
    bullet('<b>Bot itself about to flag</b> while the opponent is comfortable: it becomes far '
           'more agreeable — accept margin widens by 200 cp and its offer band by 150 cp, '
           'grabbing the half point even from better positions.'),
    note('Untimed games and games with a ≥ 10 s increment ignore the clock entirely.'),
]

story += [spacer(6)]
story += subsection('10d. Seek Stalemate When Losing — _maybeStaleSeek()')
story += [
    body('A desperation swindle mode. Once the engine eval says the bot is worse than the '
         'threshold and the game has passed the configured move number, candidate weights are '
         're-shaped toward the classic stalemate-trap recipe:'),
    bullet('Moves that reduce the bot\'s own future mobility (fewer legal replies afterwards → '
           'closer to a stalemate shape) are boosted.'),
    bullet('Desperado moves — offering the moved piece for capture — are boosted in proportion '
           'to the piece value, most of all when the piece is undefended (dumping the queen is '
           'the point).'),
    code('active if staleSeek AND fullmove ≥ fromMove AND eval ≤ −thresholdCp\n'
         'weight ×= exp( mobilityBoost + desperadoBoost )'),
    note('These picks are exempt from the §9 CP-budget check. Arming this behaviour also '
         'forces the complexity/eval probe every move so the trigger stays current.'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — PRESET PERSONALITIES
# ═══════════════════════════════════════════════════════════════════════════════
story += section('11. Preset Personalities')
story += [
    body('Each preset personality is a named collection of attractor values; loading one sets '
         'all sliders to those values (−5 to +5 scale). Some presets also reconfigure the '
         'engine, opening repertoire, or draw behaviour and confirm first via a dialog. The '
         'table below shows each personality\'s notable settings.'),
    spacer(6),
]

pers_rows = [
    ['Personality', 'Tag', 'Notable attractor values', 'Character'],
    ['Captain Entropy ⚡', 'Chaos',
     'chaos:+4, compwin:+4, gambito:+3\ntrade:+2, spacecadet:+2\nhustle:−3, structure:−3',
     'Seeks complications, gambit lines, and tactical chaos. Thinks longer per move (hustle −3).'],
    ['Norm ◼', 'Order',
     'structure:+4, fortkx:+3, spacecadet:0\nchaos:−4, compwin:−4\ngambito:−2, hustle:+2',
     'Closes positions, defends solidly. Simplifies when winning. Slightly faster pace.'],
    ['Attacky McTackerson ⚔', 'Captures',
     'trade:+4, attacker:+3, chaos:+2\nhustle:−2, structure:−1',
     'Favours captures and threats. Slightly deliberate (hustle −2).'],
    ['Overthinker ◈', 'Methodical',
     'structure:+3, spacecadet:+3, fortkx:+2\nhustle:−4, pressure:−3\nchaos:−3, compwin:−2',
     'Maximises board control and structure. Thinks long on every move (hustle −4). '
     'Likely to accumulate time pressure in classical games.'],
    ['Coffeehouse Hustler ☕', 'Fast',
     'hustle:+5, pressure:+2, luck:+2\ngambito:+2, hustle:+5\nstructure:−2',
     'Plays fast and loose. Phase temperature: T=5 opening → T=0.6 endgame. '
     'At hustle +5: think time ×0.25 of baseline.'],
    ['The Blunderer ∿', 'Human',
     'luck:+3, pressure:+5',
     'Plays normally but cracks unpredictably under pressure. Luck shifts toward lower-ranked moves.'],
    ['The Hoarder ◉', 'Material',
     'gambito:−3, trade:−3, fortkx:+2\nchaos:−2, hustle:+2, luck:−2',
     'Never sacrifices material. Avoids trades and gambits. Slight faster pace.'],
    ['Pawn Chain Gang ♟', 'Pawns',
     'structure:+5, fortkx:+1, hustle:+1\nchaos:−1, compwin:−2, gambito:−1',
     'Maximises pawn structure. Slightly faster pace.'],
    ['Spite Check †', 'Checks',
     'chaos:+3, compwin:+2, attacker:+3\ntrade:+2, hustle:−2',
     'Always prefers checking moves. Builds up attacks. Slower deliberate pace (hustle −2).'],
    ['Clock Watcher ⧗', 'Clock',
     'compwin:−2, trade:−1, pressure:−3',
     'Conservative when ahead on time, reckless when behind. Calm under pressure (pressure −3).'],
    ['Grandmaster Bad Day 👑', 'Human',
     'luck:+5, pressure:+2\n(Maia 3 @ 2400, picks lowest\nprob move above 4%)',
     'Strong player having an off day. The §9 degradation guard prevents it from ever '
     'accidentally choosing a strong move — never brilliant by mistake.'],
    ['Drunken Master 🍺', 'Human',
     'attacker:+4, chaos:+3, gambito:+3\n(Hybrid: 50% Maia 2400 +\n50% Maia 1000 per move)',
     'Each move rolls one of two Maia strengths — brilliant one move, blundering the next. '
     'Plain hybrid config, so the two slots are freely re-tunable.'],
    ['The Drawmeister ½', 'Human',
     'trade:+4, fortkx:+3, structure:+2\nchaos:−4, gambito:−3, attacker:−3\n(accepts + offers draws)',
     'Plays for the half point: simplifies, fortresses up, offers/accepts draws (§10), and '
     'installs solid drawish repertoires for both colours (London / Exchange Slav / Four '
     'Knights; Petroff / Berlin / Slav).'],
]
story.append(simple_table(pers_rows, [1.3*inch, 0.7*inch, 2.15*inch, 3.15*inch]))
story.append(spacer(4))
story.append(note('Hustle attractor sign convention: +5 = Coffeehouse Hustler (fast, thinkMs ×0.25). '
                  '−5 = Overthinker (slow, thinkMs ×1.75).'))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — TIME CONTROLS
# ═══════════════════════════════════════════════════════════════════════════════
story += section('12. Time Controls')
story += [
    body('Time controls are defined in TIME_CONTROLS and selected from the bot panel grid. '
         'The grid is divided into Blitz (≤5 min), Rapid (10–30 min), Classical/Correspondence '
         '(60 min+), Infinite (untimed), and a special 90+30 column for FIDE/Candidates format.'),
    spacer(6),
]

tc_rows = [
    ['Format', 'Base time', 'Increment', 'Bonus', 'Bonus at', 'Inc from'],
    ['Bullet 1+0', '1 min', '0 s', '—', '—', '—'],
    ['Blitz 3+2', '3 min', '2 s', '—', '—', '—'],
    ['Blitz 5+0', '5 min', '0 s', '—', '—', '—'],
    ['Rapid 10+0', '10 min', '0 s', '—', '—', '—'],
    ['Rapid 15+10', '15 min', '10 s', '—', '—', '—'],
    ['Classical 30+0', '30 min', '0 s', '—', '—', '—'],
    ['Classical 60+0', '60 min', '0 s', '—', '—', '—'],
    ['Classical 90+0', '90 min', '0 s', '—', '—', '—'],
    ['FIDE 90+30 *', '90 min', '30 s', '+30 min', 'Move 40', 'Move 41'],
    ['Untimed', '∞', '0 s', '—', '—', '—'],
]
story.append(simple_table(tc_rows,
    [1.3*inch, 0.8*inch, 0.8*inch, 0.8*inch, 0.8*inch, 0.8*inch]))

story += [
    spacer(6),
    note('* 90+30 (FIDE / Candidates): 90 minutes for first 40 moves, then +30 minutes added to '
         'both clocks at move 40. 30-second increment applies from move 41 onward. '
         'The clockBonusApplied flag prevents the bonus from being awarded twice.'),
    spacer(6),
]

story += subsection('Bonus Time Implementation')
story += [
    code('clockAfterMove():\n'
         '  fullMoveNum = ceil(gameMovesAlgebraic.length / 2)\n'
         '  if tc.bonusSecs AND fullMoveNum ≥ tc.bonusAtMove AND NOT clockBonusApplied:\n'
         '    clockTimeW += bonusSecs  (capped at 59940 s)\n'
         '    clockTimeB += bonusSecs\n'
         '    clockBonusApplied = true\n'
         '  if clockInc > 0 AND fullMoveNum ≥ tc.incFromMove:\n'
         '    add increment to side that just moved'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 11 — HUMAN BEHAVIOUR FLAGS
# ═══════════════════════════════════════════════════════════════════════════════
story += section('13. Human Behaviour Flags')
story += [
    body('Human behaviour flags add realistic timing irregularities and clock-pressure '
         'responses. Each flag is independently toggleable. They modify think time or '
         'move selection in specific situations.'),
    spacer(6),
]

flag_rows = [
    ['Flag', 'When active', 'Effect'],
    ['Move Blink\n(botBehavBlink)',
     'Maia3 mode only.\nPosition entropy < 0.5\n(forced or obvious move)',
     'Returns 200–500 ms random pause immediately, skipping full think time calculation. '
     'Simulates a human instantly playing the obvious recapture or forced reply.'],
    ['Reconsider\n(botBehavReconsider)',
     '15% random chance\nper move',
     'Multiplies computed think time by 1.5–2.5×. Simulates the human hesitation '
     'of starting to play a move then reconsidering.'],
    ['Clock Mirror\n(botBehavClockMirror)',
     'Opponent clock &lt;\nbot clock × 0.6',
     'Halves think time when the opponent is significantly lower on time. '
     'Simulates a human speeding up to maintain clock advantage.'],
    ['Clock Weaponizer\n(botWeaponizerEnabled)',
     'Bot clock ahead of opp\nby more than leadMs',
     'Returns 0 ms think time AND drops Stockfish to floor level. '
     'Maximises time pressure on the opponent by playing instantly when already ahead on clock. '
     'leadMs configured by Weaponizer Lead Time slider.'],
    ['Can Flag\n(botCanFlag)',
     'Always on or off',
     'When OFF: think time capped at max(200 ms, clockMs − 3000 ms). '
     'Prevents the bot from flagging itself. When ON: no such safeguard.'],
]
story.append(simple_table(flag_rows, [1.2*inch, 1.5*inch, 4.6*inch]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 14 — APPENDIX: PLAY FROM ANY POSITION
# ═══════════════════════════════════════════════════════════════════════════════
story += section('14. Appendix — Play From Any Position')
story += [
    body('Beyond bot configuration, games are no longer locked to the standard start. Any '
         'finished game, or any loaded PGN, can be reviewed move-by-move and resumed as a new '
         'game — against a bot or a friend — from any position along the way.'),
    spacer(6),
]

story += subsection('14a. Review & Replay')
story += [
    bullet('After any game a <b>Review</b> button enters replay of the moves just played; step '
           'to any position. The last move is highlighted exactly as in live play.'),
    bullet('On the Expert board, notation moves are <b>clickable</b> whenever no game is live — '
           'clicking one jumps the board to that position.'),
    bullet('Loaded PGNs support a [FEN] set-up header; a position-only PGN opens directly at '
           'that position, ready to play.'),
]

story += subsection('14b. Resume Play From Here')
story += [
    bullet('<b>Play from here</b> starts a bot game from the shown position (the Bot Builder '
           'opens; the configured bot then plays on from that point). Repertoire book moves are '
           'skipped, but the Lichess explorer stays active — it queries by position, so a '
           'classic position still draws real human move frequencies.'),
    bullet('<b>Invite from here</b> stages the position in the 2-player panel (a banner shows '
           'what is staged) so the initiator can first pick their colour — White, Black, or '
           'Random, regardless of whose move it is — then Start Private Game creates the room '
           '(invite link/code only; never posted to the open-challenge board). The server '
           'assigns colours and relays a sanitised start position so both boards agree; '
           'rematches restart from the same position with colours swapped.'),
    bullet('The "Play as" choice applies to every game you create, and the same freedom exists '
           'for bot continuations via the Bot Builder\'s colour picker — replay a position '
           'several times from either side.'),
    bullet('Any control that would end a game in progress (starting a new bot or online game, '
           'loading a PGN) asks for confirmation first, and every game start fully clears the '
           'previous game\'s replay state.'),
    bullet('Saving a from-a-position game writes SetUp/FEN tags (or a complete move list when '
           'the prefix is known), so a game can be saved and continued days — or years — later.'),
]

story += [
    spacer(8),
    HR(),
    spacer(6),
    dim('End of brief. For implementation details see src/50-bot-engine.js (engine), '
        'src/60-bot-ui.js (config application), src/10-app-shell.js (replay / draws / '
        'multiplayer), server.js (private rooms), and bot-control-panel.html (UI and presets).'),
    dim('Generated July 2026 — Blundermind Bot Controls, dev branch.'),
]

# ── Render ────────────────────────────────────────────────────────────────────
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(C_BG)
    canvas.rect(0, 0, letter[0], letter[1], fill=1, stroke=0)
    # Footer
    canvas.setFont('Helvetica', 7)
    canvas.setFillColor(C_DIM)
    canvas.drawString(0.75*inch, 0.4*inch, 'Blundermind — Bot Controls Technical Brief')
    canvas.drawRightString(letter[0] - 0.75*inch, 0.4*inch, f'Page {doc.page}')
    canvas.restoreState()

doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print('Written: ' + OUT)
