# Copyright (c) 2025 ByteDance Ltd. and/or its affiliates
# SPDX-License-Identifier: MIT

import unittest
from unittest.mock import patch

from trae_agent.utils.llm_clients.retry_utils import _should_retry_api_error, retry_with


class _StatusError(Exception):
    """Duck-typed stand-in for openai.APIStatusError (pre-commit 环境可能没有 openai)。"""

    def __init__(self, message="", *, status_code=None, body=None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.message = message


class TestShouldRetryApiError(unittest.TestCase):
    def test_rate_limit_429_returns_true(self):
        self.assertTrue(_should_retry_api_error(_StatusError("rate limited", status_code=429)))

    def test_server_error_5xx_returns_true(self):
        self.assertTrue(_should_retry_api_error(_StatusError("server error", status_code=500)))

    def test_server_error_502_returns_true(self):
        self.assertTrue(_should_retry_api_error(_StatusError("bad gateway", status_code=502)))

    def test_client_error_400_returns_false(self):
        self.assertFalse(_should_retry_api_error(_StatusError("bad request", status_code=400)))

    def test_gateway_404_without_model_error_returns_true(self):
        self.assertTrue(_should_retry_api_error(_StatusError("Error code: 404", status_code=404)))

    def test_gateway_html_404_returns_true(self):
        self.assertTrue(
            _should_retry_api_error(
                _StatusError("Error code: 404", status_code=404, body="404 page not found")
            )
        )

    def test_apisix_route_not_found_404_returns_true(self):
        self.assertTrue(
            _should_retry_api_error(
                _StatusError(
                    "Error code: 404",
                    status_code=404,
                    body={"error_msg": "404 Route Not Found"},
                )
            )
        )

    def test_model_not_found_404_returns_false(self):
        self.assertFalse(
            _should_retry_api_error(
                _StatusError(
                    "Error code: 404",
                    status_code=404,
                    body={
                        "error": {
                            "message": "The model `missing-model` does not exist",
                            "code": "model_not_found",
                        }
                    },
                )
            )
        )

    def test_model_not_found_in_message_without_body_returns_false(self):
        self.assertFalse(
            _should_retry_api_error(
                _StatusError(
                    "Error code: 404 - {'error': {'message': 'The model `missing-model` does not exist', 'code': 'model_not_found'}}",
                    status_code=404,
                )
            )
        )

    def test_generic_status_code_404_retries(self):
        class GatewayError(Exception):
            def __init__(self):
                super().__init__("Error code: 404")
                self.status_code = 404

        self.assertTrue(_should_retry_api_error(GatewayError()))

    def test_generic_status_400_does_not_retry(self):
        class ClientError(Exception):
            def __init__(self):
                super().__init__("bad request")
                self.status_code = 400

        self.assertFalse(_should_retry_api_error(ClientError()))

    def test_request_timeout_408_returns_true(self):
        self.assertTrue(_should_retry_api_error(_StatusError("timeout", status_code=408)))

    def test_non_api_error_returns_true(self):
        self.assertTrue(_should_retry_api_error(ValueError("some other error")))

    def test_status_code_none_returns_true(self):
        self.assertTrue(_should_retry_api_error(_StatusError("no status", status_code=None)))


class TestRetryWith(unittest.TestCase):
    def test_successful_first_call_returns_value(self):
        @retry_with
        def succeed():
            return "ok"

        self.assertEqual(succeed(), "ok")

    @patch("time.sleep")
    def test_retryable_error_eventually_succeeds(self, mock_sleep):
        call_count = [0]

        @retry_with
        def succeeds_after_two():
            call_count[0] += 1
            if call_count[0] < 3:
                raise _StatusError("server error", status_code=503)
            return "success"

        self.assertEqual(succeeds_after_two(), "success")
        self.assertEqual(call_count[0], 3)

    def test_non_retryable_error_raises_immediately(self):
        call_count = [0]

        @retry_with
        def bad_request():
            call_count[0] += 1
            raise _StatusError("bad request", status_code=400)

        with self.assertRaises(_StatusError):
            bad_request()
        self.assertEqual(call_count[0], 1)

    @patch("time.sleep")
    def test_gateway_404_retries_then_succeeds(self, mock_sleep):
        call_count = [0]

        @retry_with
        def recovers_after_404():
            call_count[0] += 1
            if call_count[0] < 3:
                raise _StatusError("Error code: 404", status_code=404)
            return "ok"

        self.assertEqual(recovers_after_404(), "ok")
        self.assertEqual(call_count[0], 3)
        self.assertGreaterEqual(mock_sleep.call_count, 2)

    @patch("time.sleep")
    def test_max_retries_exhausted_raises(self, mock_sleep):
        call_count = [0]

        @retry_with
        def always_fails():
            call_count[0] += 1
            raise _StatusError("server error", status_code=500)

        with self.assertRaises(_StatusError):
            always_fails()
        self.assertEqual(call_count[0], 4)  # 1 initial + 3 retries

    @patch("time.sleep")
    def test_non_api_exception_retries(self, mock_sleep):
        call_count = [0]

        @retry_with
        def network_error():
            call_count[0] += 1
            if call_count[0] < 2:
                raise ConnectionError("timeout")
            return "recovered"

        self.assertEqual(network_error(), "recovered")
        self.assertEqual(call_count[0], 2)

    def test_custom_provider_name_passed(self):
        @retry_with
        def check_provider():
            return "done"

        self.assertEqual(check_provider.__name__, "check_provider")

    @patch("time.sleep")
    def test_custom_max_retries(self, mock_sleep):
        call_count = [0]

        wrapped = retry_with(lambda: _increment_and_fail_500(call_count), max_retries=1)
        with self.assertRaises(_StatusError):
            wrapped()
        self.assertEqual(call_count[0], 2)  # 1 initial + 1 retry


def _increment_and_fail_500(call_count):
    call_count[0] += 1
    raise _StatusError("server error", status_code=500)


if __name__ == "__main__":
    unittest.main()
