// 导出数据装配：批量取答案裁剪图、把题库/组卷条目转成导出引擎输入
import { getSupabase, imageUrl } from '@/lib/supabase'
import type { ExportQuestionInput } from '@/lib/pdfExport'

/** 批量取一批题的答案裁剪图 URL（按页序） */
export async function fetchAnswerBoxes(questionIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>()
  if (!questionIds.length) return map
  try {
    const { data, error } = await getSupabase()
      .from('answers')
      .select('question_id, answer_boxes ( image_key, page )')
      .in('question_id', questionIds)
    if (error) throw error
    for (const row of (data ?? []) as {
      question_id: number
      answer_boxes: { image_key: string; page: number }[] | null
    }[]) {
      const boxes = [...(row.answer_boxes ?? [])].sort((a, b) => a.page - b.page)
      map.set(row.question_id, boxes.map((b) => imageUrl(b.image_key)))
    }
  } catch (e) {
    console.warn('[export] 答案图加载失败', e)
  }
  return map
}

export function toExportInput(
  base: {
    id: number
    questionNo: string | null
    sections: string[]
    paperLabel: string
    notes: string | null
    boxUrls: string[]
  },
  answerUrls: string[],
  blankPages = 0,
): ExportQuestionInput {
  return {
    id: base.id,
    questionNo: base.questionNo,
    sections: base.sections,
    paperLabel: base.paperLabel,
    notes: base.notes,
    boxes: base.boxUrls.map((url) => ({ url })),
    answerBoxes: answerUrls.map((url) => ({ url })),
    blankPages,
  }
}
