// Host 半（插件入口）：建邮件整理服务，再把工具挂上去。
//
// 账号和密码都不在插件配置里：账号存在 $DSH_HOME/mail-digest/account.json，
// 密码存 DSH 凭据库（键名 DSH_MAIL_DIGEST_MAIL），文件里没有。
import { MailDigestService } from './service.js'
import { registerTools } from './tools.js'

/** 要用 ctx.tools 注册工具，必须先声明依赖。 */
export const inject = ['tools']

export function apply(ctx) {
  const service = new MailDigestService(ctx)
  registerTools(ctx, service)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => service.dispose())
  }
}
