// Real issue paragraphs shared by the read-only and editable surface regressions.
export const mathParagraphs = [
  {
    markdown: String.raw`相对稳态偏离度 $\Delta S_i(t) = S_i(t) - \bar{S}_i(t)$、当前可用前额叶认知带宽 $B_{\text{PFC}, i}(t)$`,
    expressions: [String.raw`\Delta S_i(t) = S_i(t) - \bar{S}_i(t)`, String.raw`B_{\text{PFC}, i}(t)`],
    prose: "相对稳态偏离度 、当前可用前额叶认知带宽 ",
  },
  {
    markdown: String.raw`仅配置客观物理前置条件 $\text{Pre}_a = [\text{温水容器就绪}, \text{衣物穿戴态}=0, \text{私密遮挡}]$ 与最小机械功 $W_{\text{min}}$`,
    expressions: [String.raw`\text{Pre}_a = [\text{温水容器就绪}, \text{衣物穿戴态}=0, \text{私密遮挡}]`, String.raw`W_{\text{min}}`],
    prose: "仅配置客观物理前置条件  与最小机械功 ",
  },
  {
    markdown: String.raw`$\pi_i^*(a \mid s_t) \propto P_{0,i}(a \mid s_t) \cdot \exp(\omega_i(t) Q_i(s_t, a) - \Delta E_{\text{act}})$`,
    expressions: [String.raw`\pi_i^*(a \mid s_t) \propto P_{0,i}(a \mid s_t) \cdot \exp(\omega_i(t) Q_i(s_t, a) - \Delta E_{\text{act}})`],
    prose: "",
  },
  {
    markdown: "$a * b * c$",
    expressions: ["a * b * c"],
    prose: "",
  },
  {
    markdown: String.raw`熟练度 $\eta_{i,a} = 0.1$ 的生手耗能高达 $2.7 W_{\text{min}}$ 且注意力占用近 $80\%$，而 $\eta_{i,a} = 0.9$ 释放出近 $70\%$ 的空闲带宽 $B_{\text{free\_att}}$`,
    expressions: [String.raw`\eta_{i,a} = 0.1`, String.raw`2.7 W_{\text{min}}`, String.raw`80\%`, String.raw`\eta_{i,a} = 0.9`, String.raw`70\%`, String.raw`B_{\text{free\_att}}`],
    prose: "熟练度  的生手耗能高达  且注意力占用近 ，而  释放出近  的空闲带宽 ",
  },
];
