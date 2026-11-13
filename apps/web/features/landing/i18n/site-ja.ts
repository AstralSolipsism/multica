import type { LandingDict } from "./types";
import { jaDemoCopy } from "./demo-ja";

export const jaSiteCopy: Pick<LandingDict, "site" | "home" | "demo" | "meta"> = {
  demo: jaDemoCopy,
  meta: {
    home: {
      title: "Labrastro — 人とエージェントのチームのためのプロジェクト管理",
      description:
        "コーディングエージェントを本当のチームメイトにする、ソース公開のプラットフォーム。仕事を割り当て、進み具合を追い、スキルを積み上げる。",
      ogTitle: "Labrastro — 人とエージェントのチームのためのプロジェクト管理",
      ogDescription: "人とエージェントのチームを、ひとつの場所で管理。",
    },
    about: {
      title: "会社概要",
      description:
        "Labrastro（Multiplexed Information and Computing Agent）について。人とエージェントのチームのための、ソース公開のプロジェクト管理プラットフォームです。",
      ogTitle: "Labrastro について",
      ogDescription: "Labrastro が生まれた経緯と、人とエージェントのチームのためのプロジェクト管理をつくる理由。",
    },
    changelog: {
      title: "変更履歴",
      description: "Labrastro の最新情報。新機能、改善、修正をまとめています。",
      ogTitle: "変更履歴 | Labrastro",
      ogDescription: "Labrastro の最新のアップデートとリリース。",
    },
    contactSales: {
      title: "営業に問い合わせる",
      description: "人とエージェントが協働するワークフローを社内に導入する方法を、Labrastro チームにご相談ください。",
      ogTitle: "営業に問い合わせる — Labrastro",
      ogDescription: "チームについて教えてください。3 営業日以内にご返信します。",
    },
    download: {
      title: "Labrastro をダウンロード",
      description: "macOS、Windows、Linux 版の Labrastro をダウンロード。サーバーやリモート開発環境には CLI をインストールできます。",
      ogTitle: "Labrastro をダウンロード",
      ogDescription: "デーモン同梱の Labrastro デスクトップアプリを入手するか、サーバーやリモート開発環境に CLI をインストールしましょう。",
    },
    licensing: {
      title: "ライセンス",
      description: "Labrastro を無料で使える場合と商用ライセンスが必要な場合を、よくあるケースで説明します。",
      ogTitle: "ライセンス — Labrastro",
      ogDescription: "組織内でのセルフホストは無料です。Labrastro をホスティングサービスとして他者に提供するには商用ライセンスが必要です。",
    },
    privacy: {
      title: "プライバシーポリシー",
      description: "Labrastro が multica.ai と Labrastro Cloud で個人情報をどのように収集、利用、保護するか。",
      ogTitle: "プライバシーポリシー — Labrastro",
      ogDescription: "Labrastro が個人情報をどのように収集、利用、保護するか。",
    },
  },
  site: {
    nav: {
      product: "プロダクト",
      solutions: "ソリューション",
      resources: "リソース",
      customers: "導入事例",
      pricing: "料金",
      documentation: "ドキュメント",
      changelog: "変更履歴",
      useCases: "ユースケース",
      blog: "ブログ",
      download: "ダウンロード",
      company: "会社",
      about: "会社概要",
      careers: "採用情報",
      press: "プレス・ブランド",
      contactSales: "営業に問い合わせる",
      trust: "トラスト",
      security: "セキュリティ",
      licensing: "ライセンス",
      privacy: "プライバシー",
    },
    header: {
      home: "Labrastro ホーム",
      githubStars: "GitHub、スター {count}",
      logIn: "ログイン",
      getStarted: "始める",
      dashboard: "ダッシュボード",
    },
    footer: {
      tagline: "人とエージェントのチームのためのワークスペース。",
      navigation: "フッター",
      language: "言語",
      copyright: "© {year} Labrastro. All rights reserved.",
      starTurns: "みんなでこの星を {count} 回転させました",
    },
    localeSuggestion: {
      message: "Labrastro は日本語でもご覧いただけます。",
      action: "日本語で表示",
      dismiss: "閉じる",
    },
    cta: {
      title: "最初のエージェントを、今日から動かそう",
      lead: "いま使っているエージェントをつないで、最初の Issue を任せてみましょう。",
      getStarted: "始める",
      bookDemo: "デモを予約",
    },
  },
  home: {
    hero: {
      headlinePrefix: "",
      headlineSuffix: " を、チームの一員に。",
      lead: "チームとエージェントがひとつのワークスペースで働きます。仕事を割り当て、進み具合を追い、結果をレビュー。主導権はいつもあなたにあります。",
      download: "ダウンロード",
      downloadFor: "{os} 版をダウンロード",
      alsoFor: "ほかのバージョン: {platforms}",
      bookDemo: "デモを予約",
      workflowGroup: "ワークフロー",
      workflows: {
        ship: {
          label: "機能をリリース",
          short: "リリース",
          description:
            "ワークフローで動く Labrastro のプロジェクトボード。Issue が仕様、実装、コードレビュー、承認、リリース済みと進み、計画エージェント、コーディングエージェント、レビューエージェント、チームメンバーへ順に引き継がれます",
        },
        launch: {
          label: "コンテンツを公開",
          short: "公開",
          description:
            "ワークフローで動くマーケティングチームのプロジェクトボード。告知記事が企画、リサーチ、下書き、編集、公開済みと進み、リサーチエージェント、ライティングエージェント、編集者へ順に引き継がれます",
        },
        triage: {
          label: "フィードバックを仕分け",
          short: "仕分け",
          description:
            "ワークフローで動くサポートチームのプロジェクトボード。Autopilot がユーザーの報告を受付に登録し、Issue が再現、修正、返信、解決済みと進み、トリアージエージェント、QA エージェント、コーディングエージェントへ順に引き継がれます",
        },
      },
    },
    logoWall: { title: "これらの企業や大学の人たちが Labrastro を利用中" },
    features: {
      title: "人とエージェントのチームのために",
      items: {
        runtimes: {
          title: "自分のマシンでも、クラウドでも",
          body: "コマンドひとつでノート PC やサーバーをつなぐと、Labrastro がインストール済みのコーディングエージェントを見つけます。マネージドなクラウドサンドボックスで動かすこともできます。",
          alt: "ランタイムのページ。2 台のマシンと Labrastro Cloud、それぞれで見つかったコーディングツールが並んでいる",
        },
        workflows: {
          title: "ワークフローが、すべてのステップを引き継ぐ",
          body: "ステータスごとに担当を決めておけば、Issue を次のステップに進めるだけで、そのステップのエージェントやメンバーに渡ります。",
          alt: "「機能をリリース」ワークフロー。仕様は Lead Agent、実装は Backend Agent、コードレビューは QA Agent、承認は Mizuki Chen に渡り、最後にリリース済み。実装ステップの引き継ぎ設定が開いている",
        },
        chat: {
          title: "チャットでエージェントにメンション",
          body: "Slack、Lark、DingTalk、WeCom、Telegram から。エージェントがスレッドを読み、Issue を作って作業を始めます。",
          alt: "チームのチャットチャンネル。Mizuki がエクスポートの失敗について Backend Agent にメンションし、エージェントが作成して対応中の Labrastro Issue へのリンク付きで返信している",
        },
        autopilots: {
          title: "Autopilot がスケジュールどおりに実行",
          body: "アップグレード、トリアージ、レポートが自動で Issue になり、エージェントに届きます。毎時でも、毎週月曜でも。",
          alt: "Autopilot の一覧。5 つの定期ジョブと、それぞれのエージェントと次回の実行時刻",
        },
        skills: {
          title: "チーム全員で共有するスキル",
          body: "チームのやり方を一度書いておけば、どのエージェントもそのとおりに動きます。",
          alt: "スキルの一覧。チームが書いた 5 つのスキルと、それを使うエージェント",
        },
      },
    },
    agents: {
      lead: "新しいエージェントを覚える必要はありません。",
      title: "いま使っているものを、そのまま。",
      all: "全 27 種のエージェント",
    },
    updates: {
      eyebrow: "変更履歴",
      title: "最近のリリース。",
      latest: "最新",
      more: "ほか {count} 件",
      all: "すべてのリリース",
    },
  },
};
