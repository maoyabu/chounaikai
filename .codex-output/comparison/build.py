import json,os
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate,Paragraph,Table,TableStyle,PageBreak,Spacer
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.pagesizes import A4,landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from xml.sax.saxutils import escape
base=os.path.dirname(__file__)
d=json.load(open(base+'/data.json'))
out='/Users/oyabu/dev/chounaikai/outputs/service-comparison'
os.makedirs(out,exist_ok=True)
pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))
style=ParagraphStyle('body',fontName='HeiseiKakuGo-W5',fontSize=9,leading=13,wordWrap='CJK',textColor=colors.HexColor('#203547'))
small=ParagraphStyle('small',parent=style,fontSize=8,leading=12)
title=ParagraphStyle('title',parent=style,fontSize=18,leading=25,spaceAfter=8)
def p(t,st=style):return Paragraph(escape(t).replace('\n','<br/>'),st)
def table(rows):
 head=ParagraphStyle('head',parent=style,textColor=colors.white)
 cells=[[p(c,head) for c in d['headers']]]+[[p(c) for c in r] for r in rows]
 t=Table(cells,colWidths=[95,169,169,169,169],repeatRows=1,hAlign='LEFT')
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#18334B')),('TEXTCOLOR',(0,0),(-1,0),colors.white),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),9),('BOTTOMPADDING',(0,0),(-1,-1),9),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.HexColor('#F0F4F8'),colors.white]),('LINEBELOW',(0,0),(-1,0),1,colors.HexColor('#18334B'))]))
 for c in cells[0]:c.style=ParagraphStyle('head',parent=style,textColor=colors.white)
 return t
story=[]
for num,(label,rows) in enumerate([('機能比較 1/2',d['rows'][:10]),('機能比較 2/2',d['rows'][10:]),('料金・出典',d['prices'])]):
 if num:story.append(PageBreak())
 story.extend([p('自治会サービス比較表',title),p(label+'　｜　確認日：2026年10月30日',small),Spacer(1,10),table(rows),Spacer(1,12)])
 if num<2:story.append(p('他社は公式公開情報、まちの伝言板は開発中の仕様・コードによる比較です。「未確認」は非対応を意味しません。',small))
 else:
  for note in d['notes']:story.extend([p(note,small),Spacer(1,3)])
  story.extend([Spacer(1,8),p('出典',style)])
  for label,url in d['sources']:story.append(p(label+'：'+url,small))
  story.extend([Spacer(1,10),p(d['assessment'],small)])
def footer(c,doc):
 c.setFont('HeiseiKakuGo-W5',8);c.setFillColor(colors.HexColor('#526579'));c.drawString(34,20,'自治会サービス比較表 / 2026-10-30');c.drawRightString(807,20,str(doc.page))
doc=SimpleDocTemplate(out+'/自治会サービス比較表.pdf',pagesize=landscape(A4),rightMargin=34,leftMargin=34,topMargin=28,bottomMargin=34)
doc.build(story,onFirstPage=footer,onLaterPages=footer)
