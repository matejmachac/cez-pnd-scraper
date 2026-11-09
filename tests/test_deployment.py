from deploy.native_deploy import transport_url


def test_current_supervisor_ip_is_used_for_the_readiness_probe():
    assert (
        transport_url({"ip_address": "172.30.33.4", "hostname": "unresolvable"})
        == "http://172.30.33.4:8099"
    )
