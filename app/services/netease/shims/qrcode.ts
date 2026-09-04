// HyperPlayer adaptations: vendored 网易云协议包浏览器化 —— qrcode 浏览器 shim。
// 协议包 login_qr_create 仅在 qrimg=true 时调用 toDataURL 生成二维码图片；
// 产品侧二维码由前端服务层直接渲染（qrurl 透传），此处提供无副作用实现。

export async function toDataURL(): Promise<string> {
  return ''
}

export default { toDataURL }
