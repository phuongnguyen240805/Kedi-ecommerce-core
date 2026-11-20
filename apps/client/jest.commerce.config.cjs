module.exports={
  rootDir:'../..',
  cacheDirectory:'<rootDir>/.wrangler/jest-commerce',
  testEnvironment:'jsdom',
  testMatch:['<rootDir>/apps/client/src/pages/admin/pod-operations.test.tsx','<rootDir>/apps/client/src/pages/admin/printify.test.tsx','<rootDir>/apps/client/src/pages/admin/bank-payments.test.tsx','<rootDir>/apps/client/src/pages/admin/launch-readiness.test.tsx','<rootDir>/apps/client/src/pages/admin/marketing.test.tsx','<rootDir>/apps/client/src/pages/admin/commerce-service.test.tsx','<rootDir>/apps/client/src/pages/admin/shipping-operations-panel.test.tsx'],
  moduleNameMapper:{'^@/(.*)$':'<rootDir>/apps/client/src/$1'},
  transform:{'^.+\\.tsx?$':['ts-jest',{tsconfig:{jsx:'react-jsx',module:'CommonJS',target:'ES2022',esModuleInterop:true,isolatedModules:true,ignoreDeprecations:'6.0'}}]},
};
