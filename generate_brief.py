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

OUT = 'Blundermind_Bot_Controls_Brief.pdf'

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
    return Paragraph(txt, sCode)

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
    t = Table(rows, colWidths=col_widths)
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
    t = Table(rows, colWidths=col_widths)
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
        'This brief reflects the state of the dev branch as of June 2026.'),
    spacer(20),
]

# ── Table of contents (manual) ────────────────────────────────────────────────
toc_rows = [
    ['Section', 'Topic'],
    ['1', 'Architecture Overview — Move Selection Pipeline'],
    ['2', 'Move Source Layer (Opening Book / Maia3 / Stockfish / LCSF)'],
    ['3', 'Think Time Calculation'],
    ['4', 'Time Pressure Play Degradation (Curves A &amp; B)'],
    ['5', 'Temperature &amp; Move Sampling'],
    ['6', 'Strategic Attractors (Style Gauge)'],
    ['7', 'Piece-Type Attractors'],
    ['8', 'Move Quality Range &amp; Luck'],
    ['9', 'Preset Personalities'],
    ['10', 'Time Controls'],
    ['11', 'Human Behaviour Flags'],
]
story.append(simple_table(toc_rows, [0.5*inch, 6.8*inch]))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — ARCHITECTURE OVERVIEW
# ═══════════════════════════════════════════════════════════════════════════════
story += section('1. Architecture Overview — Move Selection Pipeline')
story += [
    body('Every bot move passes through six sequential stages. Each stage can veto, '
         'modify, or short-circuit to skip later stages. The stages run in strict order '
         'so that think time — computed in Stage 2 — feeds into every downstream '
         'degradation calculation.'),
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
    ['3', 'Engine Query', 'Rough thinkSec estimate used to pick Maia ELO (curve A). '
                          'Maia3 or LCSF queried for candidate move probabilities.'],
    ['4', 'Distribution Cut', 'Curve B sets upper percentile cutoff of candidate list. '
                               'Luck attractor shifts the sampling window up or down.'],
    ['5', 'Attractor Reweighting', 'Each candidate move\'s probability is multiplied by '
                                    'exp(logBoost) where logBoost is the sum of all active '
                                    'strategic attractor signals.'],
    ['6', 'Temperature Sampling', 'Final temperature applied (base T × phase/pressure '
                                   'modifiers). One move sampled from reweighted distribution.'],
]
story.append(simple_table(pipeline, [0.4*inch, 1.2*inch, 5.7*inch]))
story.append(spacer(8))

story += [
    body('<b>Key architectural principle:</b> Think time is computed first (Stage 2), and '
         'the resulting thinkSec value drives Stages 3, 4, and 5 via the degradation curves. '
         'This means a Coffeehouse Hustler thinking 0.3 s on a move sees heavy ELO and '
         'distribution degradation on that specific move — not an average derived from the '
         'remaining clock.'),
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
    bullet('Probability distribution filtered by quality range (§8), then reweighted by attractors (§6).'),
]

story += subsection('2c. Stockfish (SF) Engine')
story += [
    body('Used when the bot engine mode is set to Stockfish. Skill level 1–20 controlled '
         'by sfEffectiveLevel(). The engine is queried via WebWorker; MultiPV probes '
         'provide complexity scores used by the Chaos attractor.'),
    code('sfEffectiveLevel: floor = max(blunderFloor, pressureFloor)\n'
         'blunderFloor = max(1, round(startLevel × (1 − blunderLimitCp / 400)))\n'
         'pressureFloor = max(1, startLevel − round(timePressureMaxDrop / 50))'),
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
    bullet('Combined with the Move Quality Range lower bound and Luck shift (§8)'),
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
    body('After attractor reweighting, one move is sampled from the distribution using '
         'temperature-scaled probabilities. Temperature T controls how peaked or flat '
         'the distribution is before sampling.'),
    code('sampleFromProbs(moveProbs, T):\n'
         '  scaled[m] = prob[m] ^ (1/T)\n'
         '  total = Σ scaled[m]\n'
         '  sample r ~ Uniform(0, total)\n'
         '  return first m where cumulative sum ≥ r'),
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
story += section('6. Strategic Attractors (Style Gauge)')
story += [
    body('Strategic attractors reweight each candidate move\'s probability by multiplying '
         'it by exp(logBoost). The total logBoost for a move is the sum of all active '
         'attractor contributions. Attractors are zero at centre and scale linearly '
         'with slider value (−5 to +5).'),
    spacer(4),
]

story += subsection('6a. CP Budget and Scale Factor')
story += [
    body('The CP (centipawn) budget (0–300) is a single master gain knob for all attractors. '
         'It controls how strongly attractors push the distribution, regardless of the '
         'individual slider positions.'),
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
     'Shifts quality range window:\nlo = botDayLower − v × 4\nhi = _pressureUpper − v × 4',
     'See §8 Move Quality Range for full description.'],
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
# SECTION 8 — MOVE QUALITY RANGE & LUCK
# ═══════════════════════════════════════════════════════════════════════════════
story += section('8. Move Quality Range & Luck')
story += [
    body('The Move Quality Range dual slider selects which segment of the Maia probability-'
         'ranked candidate list the bot samples from. Candidates outside the [lower, upper] '
         'percentile window are excluded before temperature sampling and attractor reweighting.'),
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

story += subsection('8c. Blunder Limit and Min-Probability Filter')
story += [
    body('Two additional filters prune the candidate list before the quality range is applied:'),
    code('relFloor = bestProb × exp(−blunderLimitCp / 100)\n'
         'absFloor = minProbPct / 100\n'
         'threshold = max(absFloor, relFloor)\n'
         'keep only moves with prob ≥ threshold'),
    bullet('blunderLimitCp (0–400 cp): sets how far below the best move a candidate can fall. '
           '50 cp → tight; 400 cp → everything allowed.'),
    bullet('minProbPct (0–10%): absolute probability floor; removes near-zero candidates.'),
]
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — PRESET PERSONALITIES
# ═══════════════════════════════════════════════════════════════════════════════
story += section('9. Preset Personalities')
story += [
    body('Each preset personality is a named collection of attractor values. Loading a '
         'personality sets all attractor sliders to the preset values. The values use the '
         'same −5 to +5 scale as manual sliders. The table below shows each personality\'s '
         'non-zero attractor settings.'),
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
     'luck:+5, pressure:+2',
     'Maia 2400 ELO but samples deep in the distribution — strong player having an off day.'],
]
story.append(simple_table(pers_rows, [1.3*inch, 0.7*inch, 2.1*inch, 3.2*inch]))
story.append(spacer(4))
story.append(note('Hustle attractor sign convention: +5 = Coffeehouse Hustler (fast, thinkMs ×0.25). '
                  '−5 = Overthinker (slow, thinkMs ×1.75).'))
story.append(PageBreak())

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — TIME CONTROLS
# ═══════════════════════════════════════════════════════════════════════════════
story += section('10. Time Controls')
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
story += section('11. Human Behaviour Flags')
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
     'Opponent clock <\nbot clock × 0.6',
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

story += [
    spacer(8),
    HR(),
    spacer(6),
    dim('End of brief. For implementation details see src/50-bot-engine.js (engine), '
        'src/60-bot-ui.js (config application), and bot-control-panel.html (UI and presets).'),
    dim('Generated June 2026 — Blundermind Bot Controls v1.0'),
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
