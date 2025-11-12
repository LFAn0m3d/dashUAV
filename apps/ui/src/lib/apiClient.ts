import axios from 'axios';
import { getAppConfig } from './config';

const { API_BASE_URL } = getAppConfig();

const apiClient = axios.create({
  baseURL: API_BASE_URL || '/api',
  timeout: 10_000,
});

export default apiClient;
