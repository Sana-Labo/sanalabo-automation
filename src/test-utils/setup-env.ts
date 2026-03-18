// 사이드이펙트 모듈: 테스트용 환경변수를 설정한다.
// config.ts를 import하는 모듈보다 먼저 import할 것.
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-token";
process.env.LINE_CHANNEL_SECRET = "test-secret";
process.env.SYSTEM_ADMIN_IDS = "Uadmin00000000000000000000000001";
